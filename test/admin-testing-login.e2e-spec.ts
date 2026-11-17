import request from 'supertest';
import { ADMIN_PASSWORD, createApp, makeAdmin, resetDb, TestApp } from './helpers';

/** TEMPORARY testing switch (ADMIN_TESTING_LOGIN=true): password alone signs staff in, and several sessions can coexist. */
describe('admin testing login (temporary switch)', () => {
  let t: TestApp;
  beforeAll(async () => {
    process.env.ADMIN_TESTING_LOGIN = 'true';
    t = await createApp();
  });
  afterAll(async () => {
    delete process.env.ADMIN_TESTING_LOGIN;
    await t.app.close();
  });
  beforeEach(() => resetDb(t.prisma));

  const http = () => request(t.app.getHttpServer());
  const cookieOf = (r: request.Response) => (r.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

  it('signs in with e-mail and password only, even with a temporary password and no 2FA enrolled', async () => {
    const { admin } = await makeAdmin(t.prisma, { totp: false, mustChangePassword: true });
    const l = await http().post('/v1/admin/auth/login').send({ email: admin.email, password: ADMIN_PASSWORD });
    expect(l.status).toBe(200);
    expect(l.body.mfaRequired).toBe(false);
    const me = await http().get('/v1/admin/auth/me').set('Cookie', cookieOf(l));
    expect(me.status).toBe(200);
    expect(me.body.mustChangePassword).toBe(false);
    const dash = await http().get('/v1/admin/dashboard').set('Cookie', cookieOf(l));
    expect(dash.status).toBe(200);
  });

  it('lets two sign-ins of the same account (and other staff) stay active at once', async () => {
    const { admin } = await makeAdmin(t.prisma, { totp: false });
    const other = await makeAdmin(t.prisma, { totp: false, role: 'SUPPORT', email: 'support@examgadh.test' });
    const a = await http().post('/v1/admin/auth/login').send({ email: admin.email, password: ADMIN_PASSWORD });
    const b = await http().post('/v1/admin/auth/login').send({ email: admin.email, password: ADMIN_PASSWORD });
    const c = await http().post('/v1/admin/auth/login').send({ email: other.admin.email, password: ADMIN_PASSWORD });
    for (const r of [a, b, c]) expect((await http().get('/v1/admin/auth/me').set('Cookie', cookieOf(r))).status).toBe(200);
  });

  it('still rejects a wrong password', async () => {
    const { admin } = await makeAdmin(t.prisma, { totp: false });
    const l = await http().post('/v1/admin/auth/login').send({ email: admin.email, password: 'wrong-password-123' });
    expect(l.status).toBe(401);
  });
});
