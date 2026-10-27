import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { unauthorized } from '../common/api-error';
import { SessionService } from './session.service';

export interface AuthUser {
  id: string;
  sid: string;
}
export type AuthedRequest = Request & { user: AuthUser };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorized();

    let payload: { sub: string; sid: string };
    try {
      payload = await this.jwt.verifyAsync(token, { algorithms: ['HS256'], issuer: 'examgadh' });
    } catch (e) {
      const expired = e instanceof Error && e.name === 'TokenExpiredError';
      throw unauthorized(expired ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED', expired ? 'Access token expired' : 'Invalid token');
    }
    await this.sessions.assertActive(payload.sid, payload.sub);
    req.user = { id: payload.sub, sid: payload.sid };
    return true;
  }
}
