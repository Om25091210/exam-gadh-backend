import { Inject, Injectable } from '@nestjs/common';
import { AdminSession, AdminUser } from '@prisma/client';
import { ApiError, badRequest, unauthorized } from '../../common/api-error';
import { Clock } from '../../common/clock';
import { ENV, Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { permissionsOf } from '../rbac/permissions';
import { AdminPrincipal } from './admin-auth.types';
import { decryptSecret, DUMMY_HASH_PROMISE, encryptSecret, hashPassword, passwordProblems, randomToken, recoveryCodes, sha256, verifyPassword } from './secrets';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp';

export const SESSION_HOURS = 12;
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export interface IssuedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private invalid() {
    return unauthorized('INVALID_CREDENTIALS', 'E-mail or password is wrong');
  }

  /** Step 1. Always spends a password hash (even for unknown e-mails) so timing does not reveal accounts. */
  async login(emailRaw: string, password: string, ip?: string, userAgent?: string) {
    const email = emailRaw.trim().toLowerCase();
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    const ok = await verifyPassword(password, admin?.passwordHash ?? (await DUMMY_HASH_PROMISE));
    const now = this.clock.now();

    if (!admin || admin.disabled) {
      await this.audit.log({ actorType: 'system', actor: 'login', action: 'admin.login.failed', target: email, targetType: 'admin', ip, meta: { reason: admin ? 'disabled' : 'unknown' } });
      throw this.invalid();
    }
    if (admin.lockedUntil && admin.lockedUntil > now) {
      await this.audit.log({ actorType: 'admin', actor: admin.id, action: 'admin.login.locked', ip });
      throw this.invalid(); // same answer as a wrong password: no oracle
    }
    if (!ok) {
      const failed = admin.failedLogins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null },
      });
      await this.audit.log({ actorType: 'admin', actor: admin.id, action: lock ? 'admin.login.lockout' : 'admin.login.failed', ip });
      throw this.invalid();
    }
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { failedLogins: 0, lockedUntil: null } });
    const issued = await this.issueSession(admin.id, false, ip, userAgent);
    await this.audit.log({ actorType: 'admin', actor: admin.id, action: 'admin.login.password_ok', ip });
    return {
      issued,
      body: { mfaRequired: true, mfaEnrolled: !!admin.totpEnabledAt, mustChangePassword: admin.mustChangePassword, csrfToken: issued.csrfToken },
    };
  }

  private async issueSession(adminId: string, mfaDone: boolean, ip?: string, userAgent?: string): Promise<IssuedSession> {
    const token = randomToken();
    const csrfToken = randomToken(24);
    const expiresAt = new Date(this.clock.now().getTime() + SESSION_HOURS * 3_600_000);
    await this.prisma.adminSession.create({ data: { adminId, tokenHash: sha256(token), csrfToken, mfaDone, expiresAt, ip, userAgent: userAgent?.slice(0, 200), lastSeenAt: this.clock.now() } });
    return { token, csrfToken, expiresAt };
  }

  /** New token after a privilege change (2FA completed): defeats session fixation. */
  private async rotate(sessionId: string, mfaDone: boolean): Promise<IssuedSession> {
    const token = randomToken();
    const csrfToken = randomToken(24);
    const s = await this.prisma.adminSession.update({ where: { id: sessionId }, data: { tokenHash: sha256(token), csrfToken, mfaDone, lastSeenAt: this.clock.now() } });
    return { token, csrfToken, expiresAt: s.expiresAt };
  }

  // ------------------------------------------------------------------ 2FA enrolment and verification
  async totpSetup(p: AdminPrincipal) {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: p.id } });
    if (admin.totpEnabledAt) throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'Two-factor sign-in is already set up');
    const secret = newTotpSecret();
    await this.prisma.adminUser.update({ where: { id: p.id }, data: { totpSecretEnc: encryptSecret(secret, this.env.adminTotpKey) } });
    return { secret, otpauthUri: otpauthUri(admin.email, secret) };
  }

  async totpEnable(p: AdminPrincipal, code: string, ip?: string) {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: p.id } });
    if (admin.totpEnabledAt) throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'Two-factor sign-in is already set up');
    if (!admin.totpSecretEnc) throw badRequest('MFA_NOT_STARTED', 'Start two-factor setup first');
    const step = verifyTotp(decryptSecret(admin.totpSecretEnc, this.env.adminTotpKey), code, this.clock.now().getTime());
    if (step === null) throw badRequest('INVALID_CODE', 'That code is not correct');
    const codes = recoveryCodes();
    await this.prisma.adminUser.update({ where: { id: p.id }, data: { totpEnabledAt: this.clock.now(), lastTotpStep: step, recoveryCodeHashes: codes.map(sha256) } });
    const issued = await this.rotate(p.sessionId, true);
    await this.audit.log({ actorType: 'admin', actor: p.id, action: 'admin.mfa.enabled', ip });
    return { issued, recoveryCodes: codes }; // shown once
  }

  async mfa(p: AdminPrincipal, input: { code?: string; recoveryCode?: string }, ip?: string) {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: p.id } });
    if (!admin.totpEnabledAt || !admin.totpSecretEnc) throw badRequest('MFA_NOT_ENROLLED', 'Set up two-factor sign-in first');
    const now = this.clock.now();
    await this.assertNotLocked(admin, now);

    let good = false;
    if (input.code) {
      const step = verifyTotp(decryptSecret(admin.totpSecretEnc, this.env.adminTotpKey), input.code, now.getTime(), admin.lastTotpStep);
      if (step !== null) {
        // Compare-and-set: of two parallel requests with the same code only one can advance the step.
        const r = await this.prisma.adminUser.updateMany({ where: { id: admin.id, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] }, data: { lastTotpStep: step } });
        good = r.count === 1;
      }
    } else if (input.recoveryCode) {
      const hash = sha256(input.recoveryCode.trim().toLowerCase());
      if (admin.recoveryCodeHashes.includes(hash)) {
        const r = await this.prisma.adminUser.updateMany({ where: { id: admin.id, recoveryCodeHashes: { has: hash } }, data: { recoveryCodeHashes: admin.recoveryCodeHashes.filter((h) => h !== hash) } });
        good = r.count === 1;
        if (good) await this.audit.log({ actorType: 'admin', actor: admin.id, action: 'admin.mfa.recovery_code_used', ip });
      }
    } else {
      throw badRequest('CODE_REQUIRED', 'Send a code or a recovery code');
    }
    if (!good) {
      await this.countFailure(admin, now);
      await this.audit.log({ actorType: 'admin', actor: admin.id, action: 'admin.mfa.failed', ip });
      throw badRequest('INVALID_CODE', 'That code is not correct');
    }
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: now } });
    const issued = await this.rotate(p.sessionId, true);
    await this.audit.log({ actorType: 'admin', actor: admin.id, action: 'admin.login', ip });
    return issued;
  }

  private async assertNotLocked(admin: AdminUser, now: Date) {
    if (admin.lockedUntil && admin.lockedUntil > now) throw new ApiError(429, 'ACCOUNT_LOCKED', 'Too many wrong codes; try again later');
  }

  /** Wrong 2FA codes count toward the same lockout as wrong passwords. */
  private async countFailure(admin: AdminUser, now: Date) {
    const failed = admin.failedLogins + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null } });
    if (lock) await this.prisma.adminSession.updateMany({ where: { adminId: admin.id, revokedAt: null }, data: { revokedAt: now } });
  }

  // ------------------------------------------------------------------ session + password
  async logout(p: AdminPrincipal, ip?: string) {
    await this.prisma.adminSession.update({ where: { id: p.sessionId }, data: { revokedAt: this.clock.now() } });
    await this.audit.log({ actorType: 'admin', actor: p.id, action: 'admin.logout', ip });
  }

  me(p: AdminPrincipal) {
    return { id: p.id, email: p.email, name: p.name, role: p.role, permissions: permissionsOf(p.role), csrfToken: p.csrfToken, mustChangePassword: p.mustChangePassword };
  }

  async changePassword(p: AdminPrincipal, current: string, next: string, ip?: string) {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: p.id } });
    if (!(await verifyPassword(current, admin.passwordHash))) throw badRequest('WRONG_PASSWORD', 'Current password is wrong');
    const problems = passwordProblems(next, admin.email);
    if (problems.length) throw badRequest('WEAK_PASSWORD', 'The new password is not strong enough', problems);
    if (await verifyPassword(next, admin.passwordHash)) throw badRequest('SAME_PASSWORD', 'Choose a different password');
    await this.prisma.adminUser.update({ where: { id: p.id }, data: { passwordHash: await hashPassword(next), mustChangePassword: false } });
    // Every other session ends; this one continues.
    await this.prisma.adminSession.updateMany({ where: { adminId: p.id, revokedAt: null, id: { not: p.sessionId } }, data: { revokedAt: this.clock.now() } });
    await this.audit.log({ actorType: 'admin', actor: p.id, action: 'admin.password.changed', ip });
  }
}

export type SessionRow = AdminSession;
