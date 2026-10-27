import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createApp, login, resetDb } from './helpers';

describe('auth and single active session', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => ({ app, prisma } = await createApp()));
  beforeEach(() => resetDb(prisma));
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer());

  it('rejects a malformed login body with VALIDATION_FAILED', async () => {
    const res = await http().post('/v1/auth/google').send({ idToken: 'x' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual(
      expect.arrayContaining(['deviceId', 'platform']),
    );
  });

  it('rejects unknown fields', async () => {
    const res = await http()
      .post('/v1/auth/google')
      .send({ idToken: 'good:a:a@x.com', deviceId: 'device-12345', platform: 'android', isAdmin: true })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unverifiable Google token', async () => {
    const res = await http()
      .post('/v1/auth/google')
      .send({ idToken: 'forged', deviceId: 'device-12345', platform: 'android' })
      .expect(401);
    expect(res.body.error.code).toBe('INVALID_GOOGLE_TOKEN');
  });

  it('signs in, creates the user once and serves /me', async () => {
    const first = await login(app, 'u1');
    expect(first.status).toBe(200);
    expect(first.body.user.email).toBe('u1@example.com');
    expect(first.body.endedOtherSession).toBe(false);
    const me = await http().get('/v1/me').set(bearer(first.body.accessToken)).expect(200);
    expect(me.body.email).toBe('u1@example.com');
    expect(me.body.entitlements).toEqual([]);
    await login(app, 'u1', 'device-u1-1');
    expect(await prisma.user.count()).toBe(1);
  });

  it('requires a token for protected routes', async () => {
    const res = await http().get('/v1/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    await http().get('/v1/me').set(bearer('not.a.jwt')).expect(401);
  });

  it('a second device login ends the first session (newest wins)', async () => {
    const phone = await login(app, 'u2', 'device-phone-01', 'android');
    await http().get('/v1/me').set(bearer(phone.body.accessToken)).expect(200);

    const web = await login(app, 'u2', 'device-web-001', 'web');
    expect(web.body.endedOtherSession).toBe(true);

    const old = await http().get('/v1/me').set(bearer(phone.body.accessToken)).expect(401);
    expect(old.body.error.code).toBe('SESSION_REPLACED');
    await http().get('/v1/me').set(bearer(web.body.accessToken)).expect(200);

    const active = await prisma.session.count({ where: { revokedAt: null } });
    expect(active).toBe(1);
  });

  it("one user's login does not affect another user's session", async () => {
    const a = await login(app, 'a');
    await login(app, 'b');
    await http().get('/v1/me').set(bearer(a.body.accessToken)).expect(200);
  });

  it('rotates refresh tokens and detects reuse of an old one', async () => {
    const s = await login(app, 'u3');
    const r1 = await http().post('/v1/auth/refresh').send({ refreshToken: s.body.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(s.body.refreshToken);
    await http().get('/v1/me').set(bearer(r1.body.accessToken)).expect(200);

    // Replaying the first (already rotated) token is treated as theft: the session is revoked.
    const replay = await http().post('/v1/auth/refresh').send({ refreshToken: s.body.refreshToken }).expect(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSE');
    const afterwards = await http().post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
    expect(afterwards.body.error.code).toBe('SESSION_REVOKED');
    await http().get('/v1/me').set(bearer(r1.body.accessToken)).expect(401);
  });

  it('rejects garbage refresh tokens', async () => {
    const res = await http().post('/v1/auth/refresh').send({ refreshToken: 'abc.def' }).expect(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH');
  });

  it('logout revokes the session immediately', async () => {
    const s = await login(app, 'u4');
    await http().post('/v1/auth/logout').set(bearer(s.body.accessToken)).expect(204);
    const res = await http().get('/v1/me').set(bearer(s.body.accessToken)).expect(401);
    expect(res.body.error.code).toBe('SESSION_REVOKED');
  });

  it('PATCH /me validates the exam and language', async () => {
    const s = await login(app, 'u5');
    const h = bearer(s.body.accessToken);
    await http().patch('/v1/me').set(h).send({ language: 'fr' }).expect(400);
    const bad = await http().patch('/v1/me').set(h).send({ targetExam: 'nope' }).expect(400);
    expect(bad.body.error.code).toBe('UNKNOWN_EXAM');
    await prisma.exam.create({ data: { id: 'cgpsc', nameEn: 'x', nameHi: 'x', shortEn: 'x', shortHi: 'x' } });
    const ok = await http().patch('/v1/me').set(h).send({ targetExam: 'cgpsc', language: 'en', district: 'Raipur' }).expect(200);
    expect(ok.body).toMatchObject({ targetExam: 'cgpsc', language: 'en', district: 'Raipur' });
  });
});
