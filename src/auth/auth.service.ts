import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SessionRevokeReason, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ENV, Env } from '../config/env';
import { conflict, forbidden } from '../common/api-error';
import { GoogleVerifier } from './google-verifier';
import { SessionService } from './session.service';
import { GoogleLoginDto } from './auth.dto';

export const publicUser = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  avatarUrl: u.avatarUrl,
  language: u.language,
  district: u.district,
  targetExam: u.targetExam,
});

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleVerifier,
    private readonly sessions: SessionService,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private signAccess(userId: string, sessionId: string) {
    return this.jwt.signAsync(
      { sub: userId, sid: sessionId },
      { expiresIn: this.env.accessTtlSec, issuer: 'examgadh', algorithm: 'HS256' },
    );
  }

  async loginWithGoogle(dto: GoogleLoginDto, ip?: string) {
    const id = await this.google.verify(dto.idToken);

    let user = await this.prisma.user.findUnique({ where: { googleSub: id.sub } });
    if (!user) {
      const emailOwner = await this.prisma.user.findUnique({ where: { email: id.email } });
      if (emailOwner) throw conflict('EMAIL_IN_USE', 'This email is linked to another Google account');
      user = await this.prisma.user.create({
        data: { googleSub: id.sub, email: id.email, name: id.name, avatarUrl: id.picture },
      });
    }
    if (user.deletedAt) throw forbidden('ACCOUNT_DELETED', 'This account was deleted');
    if (user.status === 'suspended') throw forbidden('ACCOUNT_SUSPENDED', 'Your account is suspended. Contact support.');
    await this.prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });

    const { session, refreshToken, replaced } = await this.sessions.create(user.id, {
      deviceId: dto.deviceId,
      deviceName: dto.deviceName,
      platform: dto.platform,
      ip,
    });
    return {
      accessToken: await this.signAccess(user.id, session.id),
      refreshToken,
      expiresIn: this.env.accessTtlSec,
      user: publicUser(user),
      // true when this sign-in ended a session on another device (the client may tell the user)
      endedOtherSession: replaced > 0,
    };
  }

  async refresh(refreshToken: string) {
    const { session, refreshToken: next } = await this.sessions.rotate(refreshToken);
    return {
      accessToken: await this.signAccess(session.userId, session.id),
      refreshToken: next,
      expiresIn: this.env.accessTtlSec,
    };
  }

  async logout(sessionId: string) {
    await this.sessions.revoke(sessionId, SessionRevokeReason.LOGOUT);
  }
}
