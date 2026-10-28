import { Injectable } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { ApiError, badRequest, notFound } from '../../common/api-error';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from './admin-auth.types';
import { hashPassword, temporaryPassword } from './secrets';

const view = (a: { id: string; email: string; name: string; role: StaffRole; disabled: boolean; totpEnabledAt: Date | null; lastLoginAt: Date | null; mustChangePassword: boolean; createdAt: Date }) => ({
  id: a.id,
  email: a.email,
  name: a.name,
  role: a.role,
  disabled: a.disabled,
  mfaEnrolled: !!a.totpEnabledAt,
  lastLoginAt: a.lastLoginAt,
  mustChangePassword: a.mustChangePassword,
  createdAt: a.createdAt,
});

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list() {
    return (await this.prisma.adminUser.findMany({ orderBy: { createdAt: 'asc' } })).map(view);
  }

  async create(by: AdminPrincipal, input: { email: string; name: string; role: StaffRole }, ip?: string) {
    const email = input.email.trim().toLowerCase();
    if (await this.prisma.adminUser.findUnique({ where: { email } })) throw new ApiError(409, 'EMAIL_IN_USE', 'A staff account with this e-mail exists');
    const temp = temporaryPassword();
    const created = await this.prisma.adminUser.create({ data: { email, name: input.name.trim(), role: input.role, passwordHash: await hashPassword(temp), mustChangePassword: true, createdById: by.id } });
    await this.audit.log({ actorType: 'admin', actor: by.id, action: 'staff.created', target: created.id, targetType: 'admin', after: { email, role: input.role }, ip });
    return { ...view(created), temporaryPassword: temp }; // shown once; the person must change it at first sign-in
  }

  async update(by: AdminPrincipal, id: string, patch: { role?: StaffRole; disabled?: boolean; name?: string }, ip?: string) {
    const target = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!target) throw notFound('Staff member');
    if (id === by.id && (patch.role !== undefined || patch.disabled !== undefined)) throw badRequest('SELF_CHANGE', 'You cannot change your own role or disable yourself');
    const losesSuper = target.role === 'SUPER_ADMIN' && ((patch.role && patch.role !== 'SUPER_ADMIN') || patch.disabled === true);
    if (losesSuper) {
      const others = await this.prisma.adminUser.count({ where: { role: 'SUPER_ADMIN', disabled: false, id: { not: id } } });
      if (others === 0) throw badRequest('LAST_SUPER_ADMIN', 'There must always be one active super admin');
    }
    const updated = await this.prisma.adminUser.update({ where: { id }, data: patch });
    if (patch.disabled === true) await this.revokeSessions(id);
    await this.audit.log({ actorType: 'admin', actor: by.id, action: 'staff.updated', target: id, targetType: 'admin', before: { role: target.role, disabled: target.disabled, name: target.name }, after: patch, ip });
    return view(updated);
  }

  /** Lost phone: clears 2FA so the person enrols again at next sign-in. */
  async resetMfa(by: AdminPrincipal, id: string, ip?: string) {
    await this.mustExist(id);
    await this.prisma.adminUser.update({ where: { id }, data: { totpSecretEnc: null, totpEnabledAt: null, lastTotpStep: null, recoveryCodeHashes: [] } });
    await this.revokeSessions(id);
    await this.audit.log({ actorType: 'admin', actor: by.id, action: 'staff.mfa_reset', target: id, targetType: 'admin', ip });
  }

  async resetPassword(by: AdminPrincipal, id: string, ip?: string) {
    await this.mustExist(id);
    const temp = temporaryPassword();
    await this.prisma.adminUser.update({ where: { id }, data: { passwordHash: await hashPassword(temp), mustChangePassword: true, failedLogins: 0, lockedUntil: null } });
    await this.revokeSessions(id);
    await this.audit.log({ actorType: 'admin', actor: by.id, action: 'staff.password_reset', target: id, targetType: 'admin', ip });
    return { temporaryPassword: temp };
  }

  async revokeSessions(id: string) {
    await this.prisma.adminSession.updateMany({ where: { adminId: id, revokedAt: null }, data: { revokedAt: this.clock.now() } });
  }

  private async mustExist(id: string) {
    if (!(await this.prisma.adminUser.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Staff member');
  }
}
