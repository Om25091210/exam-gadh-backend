import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { GoogleIdentity, GoogleVerifier } from '../src/auth/google-verifier';
import { PaymentGateway } from '../src/billing/razorpay.gateway';
import { PrismaService } from '../src/prisma/prisma.service';

/** "good:<sub>:<email>" is a valid fake Google token; anything else is rejected. */
class FakeGoogle extends GoogleVerifier {
  async verify(idToken: string): Promise<GoogleIdentity> {
    const [tag, sub, email] = idToken.split(':');
    if (tag !== 'good') throw Object.assign(new Error('bad'), { fake: true });
    return { sub, email, name: `User ${sub}` };
  }
}

let orderSeq = 0;
class FakeGateway extends PaymentGateway {
  get keyId() {
    return 'rzp_test_key';
  }
  async createOrder() {
    return { id: `order_fake_${++orderSeq}_${Date.now()}` };
  }
}

export async function createApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleVerifier)
    .useValue({
      verify: async (t: string) => {
        try {
          return await new FakeGoogle().verify(t);
        } catch {
          const { unauthorized } = await import('../src/common/api-error');
          throw unauthorized('INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified');
        }
      },
    })
    .overrideProvider(PaymentGateway)
    .useValue(new FakeGateway())
    .compile();
  const app = mod.createNestApplication({ rawBody: true });
  configureApp(app, { logger: false });
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}

export async function resetDb(prisma: PrismaService) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function login(app: INestApplication, sub: string, deviceId = `device-${sub}-1`, platform = 'android') {
  const res = await request(app.getHttpServer())
    .post('/v1/auth/google')
    .send({ idToken: `good:${sub}:${sub}@example.com`, deviceId, platform });
  return res;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const rzpSignature = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');
