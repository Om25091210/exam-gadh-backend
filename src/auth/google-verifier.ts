import { Inject, Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { ENV, Env } from '../config/env';
import { unauthorized } from '../common/api-error';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

/** Port so tests (and a future provider) can replace the real Google call. */
export abstract class GoogleVerifier {
  abstract verify(idToken: string): Promise<GoogleIdentity>;
}

@Injectable()
export class GoogleOAuthVerifier extends GoogleVerifier {
  private readonly client = new OAuth2Client();

  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.env.googleClientIds });
      const p = ticket.getPayload();
      if (!p?.sub || !p.email || !p.email_verified) {
        throw new Error('incomplete or unverified Google identity');
      }
      return { sub: p.sub, email: p.email.toLowerCase(), name: p.name ?? p.email, picture: p.picture };
    } catch {
      throw unauthorized('INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified');
    }
  }
}
