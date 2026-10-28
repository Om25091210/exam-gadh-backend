import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '../../common/api-error';
import { Clock } from '../../common/clock';
import { ENV, Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { can, permissionsOf, Permission } from '../rbac/permissions';
import { ADMIN_COOKIE, AdminRequest } from './admin-auth.types';
import { ANY_ADMIN_KEY, PASSWORD_CHANGE_OK_KEY, PERMISSION_KEY, PRE_MFA_KEY } from './admin.decorators';
import { sha256 } from './secrets';

export const IDLE_MS = 30 * 60_000;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Admin requests are authenticated by an opaque cookie session. The guard:
 *  1. resolves the session and the admin from the database on EVERY request, so a role change, a disabled
 *     account or a revoked session takes effect on the very next request;
 *  2. requires 2FA to be complete (except for the sign-in routes);
 *  3. requires the declared permission, and DENIES routes that declare none (fail closed);
 *  4. enforces CSRF (token bound to the session) and the Origin allow-list on every unsafe method.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const token = readCookie(req.headers.cookie, ADMIN_COOKIE);
    if (!token) throw new ApiError(401, 'ADMIN_UNAUTHENTICATED', 'Sign in required');
    const now = this.clock.now();

    const session = await this.prisma.adminSession.findUnique({ where: { tokenHash: sha256(token) }, include: { admin: true } });
    if (!session || session.revokedAt || session.expiresAt <= now || now.getTime() - session.lastSeenAt.getTime() > IDLE_MS) {
      throw new ApiError(401, 'ADMIN_UNAUTHENTICATED', 'Session expired, sign in again');
    }
    if (session.admin.disabled) throw new ApiError(401, 'ADMIN_DISABLED', 'This account is disabled');

    const handler = ctx.getHandler();
    const klass = ctx.getClass();
    const meta = <T>(key: string) => this.reflector.getAllAndOverride<T>(key, [handler, klass]);
    const preMfa = meta<boolean>(PRE_MFA_KEY) === true;
    const anyAdmin = meta<boolean>(ANY_ADMIN_KEY) === true;
    const permission = meta<Permission>(PERMISSION_KEY);

    if (!SAFE.has(req.method)) {
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !eq(csrf, session.csrfToken)) throw new ApiError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token');
      const origin = req.headers.origin;
      if (origin && this.env.corsOrigins.length > 0 && !this.env.corsOrigins.includes(origin)) {
        throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
      }
    }
    if (!session.mfaDone && !preMfa) throw new ApiError(401, 'MFA_REQUIRED', 'Finish two-factor sign-in first');
    if (session.admin.mustChangePassword && meta<boolean>(PASSWORD_CHANGE_OK_KEY) !== true) {
      throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password before continuing');
    }
    if (permission) {
      if (!can(session.admin.role, permission)) throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to do this', { required: permission });
    } else if (!anyAdmin) {
      // A route that forgot to declare a permission is closed, not open.
      throw new ApiError(403, 'PERMISSION_UNDECLARED', 'This route has no permission rule');
    }

    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    req.admin = {
      id: session.admin.id,
      email: session.admin.email,
      name: session.admin.name,
      role: session.admin.role,
      sessionId: session.id,
      csrfToken: session.csrfToken,
      mfaDone: session.mfaDone,
      mustChangePassword: session.admin.mustChangePassword,
      permissions: permissionsOf(session.admin.role),
    };
    return true;
  }
}
