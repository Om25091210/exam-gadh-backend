import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SessionRevokeReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ENV, Env } from '../config/env';
import { unauthorized } from '../common/api-error';

export interface DeviceInfo {
  deviceId: string;
  deviceName?: string;
  platform: string;
  ip?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

type CacheEntry = { active: boolean; reason?: SessionRevokeReason; until: number };

/**
 * One active session per user (requirement FR-003): creating a session revokes every other one,
 * web and app included. The `sessions` table is the source of truth; a few seconds of in-process
 * cache keeps the per-request check cheap (Redis joins when the realtime tier arrives).
 */
@Injectable()
export class SessionService {
  private readonly cache = new Map<string, CacheEntry>();
  private static readonly CACHE_MS = 5000;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private newRefreshSecret() {
    return randomBytes(32).toString('base64url');
  }

  async create(userId: string, device: DeviceInfo) {
    const secret = this.newRefreshSecret();
    const expiresAt = new Date(Date.now() + this.env.refreshTtlDays * 86_400_000);
    const { session, replaced } = await this.prisma.$transaction(async (tx) => {
      const revoked = await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: SessionRevokeReason.REPLACED },
      });
      const created = await tx.session.create({
        data: {
          userId,
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          platform: device.platform,
          ip: device.ip,
          refreshTokenHash: '',
          expiresAt,
        },
      });
      const updated = await tx.session.update({
        where: { id: created.id },
        data: { refreshTokenHash: sha256(secret) },
      });
      return { session: updated, replaced: revoked.count };
    });
    this.cache.clear();
    return { session, refreshToken: `${session.id}.${secret}`, replaced };
  }

  /** Rotates the refresh token; replaying an already-rotated token revokes the whole session. */
  async rotate(refreshToken: string) {
    const dot = refreshToken.indexOf('.');
    const sid = dot > 0 ? refreshToken.slice(0, dot) : '';
    const secret = dot > 0 ? refreshToken.slice(dot + 1) : '';
    if (!/^[0-9a-f-]{36}$/.test(sid) || !secret) throw unauthorized('INVALID_REFRESH', 'Invalid refresh token');

    const session = await this.prisma.session.findUnique({ where: { id: sid } });
    if (!session) throw unauthorized('INVALID_REFRESH', 'Invalid refresh token');
    if (session.revokedAt) {
      throw unauthorized(this.codeFor(session.revokeReason), 'This session is no longer active');
    }
    if (session.expiresAt <= new Date()) throw unauthorized('SESSION_EXPIRED', 'Session expired, sign in again');

    const presented = sha256(secret);
    if (!safeEq(presented, session.refreshTokenHash)) {
      if (session.prevRefreshHash && safeEq(presented, session.prevRefreshHash)) {
        await this.revoke(session.id, SessionRevokeReason.REFRESH_REUSE);
        throw unauthorized('REFRESH_REUSE', 'Refresh token reuse detected; signed out for safety');
      }
      throw unauthorized('INVALID_REFRESH', 'Invalid refresh token');
    }

    const next = this.newRefreshSecret();
    const updated = await this.prisma.session.update({
      where: { id: session.id },
      data: {
        prevRefreshHash: session.refreshTokenHash,
        refreshTokenHash: sha256(next),
        lastSeenAt: new Date(),
      },
    });
    return { session: updated, refreshToken: `${updated.id}.${next}` };
  }

  async revoke(sessionId: string, reason: SessionRevokeReason) {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    this.cache.delete(sessionId);
  }

  codeFor(reason?: SessionRevokeReason | null) {
    if (reason === SessionRevokeReason.REPLACED) return 'SESSION_REPLACED';
    if (reason === SessionRevokeReason.SUSPENDED) return 'ACCOUNT_SUSPENDED';
    return 'SESSION_REVOKED';
  }

  /** Ends every session of a user at once (suspension, admin action). Effective on the very next request. */
  async revokeAllForUser(userId: string, reason: SessionRevokeReason) {
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: reason } });
    this.cache.clear();
  }

  /** Per-request check used by the auth guard. */
  async assertActive(sessionId: string, userId: string): Promise<void> {
    const hit = this.cache.get(sessionId);
    if (hit && hit.until > Date.now()) {
      if (!hit.active) throw unauthorized(this.codeFor(hit.reason), 'This session is no longer active');
      return;
    }
    const s = await this.prisma.session.findUnique({ where: { id: sessionId }, include: { user: { select: { status: true } } } });
    const suspended = s?.user.status === 'suspended';
    const active = !!s && s.userId === userId && !s.revokedAt && s.expiresAt > new Date() && !suspended;
    const reason = suspended ? SessionRevokeReason.SUSPENDED : (s?.revokeReason ?? undefined);
    this.cache.set(sessionId, { active, reason, until: Date.now() + SessionService.CACHE_MS });
    if (!active) throw unauthorized(this.codeFor(reason), suspended ? 'Your account is suspended' : 'This session is no longer active');
  }
}
