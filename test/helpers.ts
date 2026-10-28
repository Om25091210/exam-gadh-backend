import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { bootstrapApp } from '../src/bootstrap';
import { GoogleIdentity, GoogleVerifier } from '../src/auth/google-verifier';
import { GatewayPayment, PaymentGateway } from '../src/billing/razorpay.gateway';
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
export class FakeGateway extends PaymentGateway {
  /** What the pretend gateway reports in `listPayments`; tests set it. */
  payments: GatewayPayment[] = [];
  refunds: Array<{ paymentId: string; amountPaise: number }> = [];
  failRefunds = false;
  get keyId() {
    return 'rzp_test_key';
  }
  async createOrder() {
    return { id: `order_fake_${++orderSeq}_${Date.now()}` };
  }
  async refund(paymentId: string, amountPaise: number) {
    if (this.failRefunds) throw new Error('gateway down');
    this.refunds.push({ paymentId, amountPaise });
    return { id: `rfnd_${this.refunds.length}_${Date.now()}` };
  }
  async listPayments() {
    return this.payments;
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
  gateway: FakeGateway;
  app: INestApplication;
  prisma: PrismaService;
  clock: FakeClock;
  finalizer: AttemptFinalizer;
}

export async function createApp(): Promise<TestApp> {
  const clock = new FakeClock();
  const gateway = new FakeGateway();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleVerifier)
    .useValue(new FakeGoogle())
    .overrideProvider(PaymentGateway)
    .useValue(gateway)
    .overrideProvider(Clock)
    .useValue(clock)
    .compile();
  const app = mod.createNestApplication({ rawBody: true });
  bootstrapApp(app, { logger: false });
  await app.init();
  return { app, prisma: app.get(PrismaService), clock, finalizer: app.get(AttemptFinalizer), gateway };
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

// ---------------------------------------------------------------- admin helpers
import { StaffRole } from '@prisma/client';
import { encryptSecret, hashPassword } from '../src/modules/admin-auth/secrets';
import { base32Decode, newTotpSecret, totp } from '../src/modules/admin-auth/totp';

export const ADMIN_PASSWORD = 'Correct-Horse-42x';

export async function makeAdmin(prisma: PrismaService, o: { email?: string; role?: StaffRole; totp?: boolean; mustChangePassword?: boolean; password?: string } = {}) {
  const secret = newTotpSecret();
  const admin = await prisma.adminUser.create({
    data: {
      email: o.email ?? `${(o.role ?? 'SUPER_ADMIN').toLowerCase()}@examgadh.test`,
      name: 'Test Admin',
      role: o.role ?? 'SUPER_ADMIN',
      passwordHash: await hashPassword(o.password ?? ADMIN_PASSWORD),
      mustChangePassword: o.mustChangePassword ?? false,
      ...(o.totp === false ? {} : { totpSecretEnc: encryptSecret(secret, Buffer.alloc(32, 7)), totpEnabledAt: new Date() }),
    },
  });
  return { admin, secret };
}

export const codeFor = (secret: string, clock: FakeClock) => totp(base32Decode(secret), clock.now().getTime());

export interface AdminHandle {
  cookie: string;
  csrf: string;
  id: string;
  headers: Record<string, string>;
  secret: string;
}

/** Full sign-in: password, then a TOTP code. Moves the fake clock one step so the code is never a replay. */
export async function adminSignIn(app: INestApplication, clock: FakeClock, adminRow: { id: string; email: string }, secret: string, password = ADMIN_PASSWORD): Promise<AdminHandle> {
  clock.advance(31_000);
  const l = await request(app.getHttpServer()).post('/v1/admin/auth/login').send({ email: adminRow.email, password });
  if (l.status !== 200) throw new Error(`admin login failed: ${l.status} ${JSON.stringify(l.body)}`);
  let cookie = (l.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  const m = await request(app.getHttpServer()).post('/v1/admin/auth/mfa').set('Cookie', cookie).set('x-csrf-token', l.body.csrfToken).send({ code: codeFor(secret, clock) });
  if (m.status !== 200) throw new Error(`admin mfa failed: ${m.status} ${JSON.stringify(m.body)}`);
  cookie = (m.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  return { cookie, csrf: m.body.csrfToken, id: adminRow.id, secret, headers: { Cookie: cookie, 'x-csrf-token': m.body.csrfToken } };
}

export async function signedInAdmin(app: INestApplication, prisma: PrismaService, clock: FakeClock, role: StaffRole = 'SUPER_ADMIN', email?: string) {
  const { admin, secret } = await makeAdmin(prisma, { role, email });
  return adminSignIn(app, clock, admin, secret);
}
