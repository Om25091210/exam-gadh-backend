import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { bootstrapApp } from '../src/bootstrap';
import { GoogleIdentity, GoogleVerifier } from '../src/auth/google-verifier';
import { PaymentGateway } from '../src/billing/razorpay.gateway';
import { Clock } from '../src/common/clock';
import { unauthorized } from '../src/common/api-error';
import { AttemptFinalizer } from '../src/modules/attempts/attempt-finalizer';
import { PrismaService } from '../src/prisma/prisma.service';

/** "good:<sub>:<email>[:<name>]" is a valid fake Google token; anything else is rejected. */
class FakeGoogle extends GoogleVerifier {
  async verify(idToken: string): Promise<GoogleIdentity> {
    const [tag, sub, email, name] = idToken.split(':');
    if (tag !== 'good') throw unauthorized('INVALID_GOOGLE_TOKEN', 'Google sign-in could not be verified');
    return { sub, email, name: name ?? `User ${sub}` };
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

/** Controllable clock so deadlines can be crossed without sleeping. */
export class FakeClock extends Clock {
  private t = Date.now();
  now() {
    return new Date(this.t);
  }
  set(d: Date) {
    this.t = d.getTime();
  }
  advance(ms: number) {
    this.t += ms;
  }
  reset() {
    this.t = Date.now();
  }
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  clock: FakeClock;
  finalizer: AttemptFinalizer;
}

export async function createApp(): Promise<TestApp> {
  const clock = new FakeClock();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleVerifier)
    .useValue(new FakeGoogle())
    .overrideProvider(PaymentGateway)
    .useValue(new FakeGateway())
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = mod.createNestApplication({ rawBody: true });
  bootstrapApp(app, { logger: false });
  await app.init();
  return { app, prisma: app.get(PrismaService), clock, finalizer: app.get(AttemptFinalizer) };
}

export async function resetDb(prisma: PrismaService) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function login(app: INestApplication, sub: string, deviceId = `device-${sub}-1`, platform = 'android', name?: string) {
  return request(app.getHttpServer())
    .post('/v1/auth/google')
    .send({ idToken: `good:${sub}:${sub}@example.com${name ? ':' + name : ''}`, deviceId, platform });
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const rzpSignature = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');
