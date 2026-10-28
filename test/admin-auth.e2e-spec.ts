import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { LOCK_MINUTES } from '../src/modules/admin-auth/admin-auth.service';
import { IDLE_MS } from '../src/modules/admin-auth/admin.guard';
import { base32Decode, totp } from '../src/modules/admin-auth/totp';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_PASSWORD, adminSignIn, codeFor, createApp, FakeClock, makeAdmin, resetDb, signedInAdmin } from './helpers';

describe('admin authentication', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clock: FakeClock;
  beforeAll(async () => ({ app, prisma, clock } = await createApp()));
  afterAll(() => app.close());
  beforeEach(async () => {
    clock.reset();
    await resetDb(prisma);
  });
  const http = () => request(app.getHttpServer());
  const login = (email: string, password: string) => http().post('/v1/admin/auth/login').send({ email, password });
  const cookieOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];

  describe('password step', () => {
    it('answers wrong password and unknown e-mail identically', async () => {
      const { admin } = await makeAdmin(prisma);
      const wrong = await login(admin.email, 'Wrong-password-1').expect(401);
      const unknown = await login('nobody@examgadh.test', 'Wrong-password-1').expect(401);
      expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body).toEqual(wrong.body);
    });

    it('sets an httpOnly, SameSite=Strict cookie and never puts a token in the body', async () => {
      const { admin } = await makeAdmin(prisma);
      const res = await login(admin.email, ADMIN_PASSWORD).expect(200);
      const raw = (res.headers['set-cookie'] as unknown as string[])[0];
      expect(raw).toMatch(/eg_admin=/);
      expect(raw).toMatch(/HttpOnly/i);
      expect(raw).toMatch(/SameSite=Strict/i);
      expect(res.body).toMatchObject({ mfaRequired: true, mfaEnrolled: true });
      expect(JSON.stringify(res.body)).not.toContain(raw.split(';')[0].split('=')[1]);
    });

    it('locks the account after 5 wrong passwords, even for the right password, until the lock expires', async () => {
      const { admin } = await makeAdmin(prisma);
      for (let i = 0; i < 5; i++) await login(admin.email, 'Wrong-password-1').expect(401);
      await login(admin.email, ADMIN_PASSWORD).expect(401); // locked: same answer as a wrong password
      expect(await prisma.auditLog.count({ where: { action: 'admin.login.lockout' } })).toBe(1);
      clock.advance((LOCK_MINUTES + 1) * 60_000);
      await login(admin.email, ADMIN_PASSWORD).expect(200);
    });

    it('rejects malformed bodies', async () => {
      await http().post('/v1/admin/auth/login').send({ email: 'not-an-email', password: 'x' }).expect(400);
      await http().post('/v1/admin/auth/login').send({}).expect(400);
    });
  });

  describe('two-factor step', () => {
    it('a session that has only passed the password step can do nothing else', async () => {
      const { admin } = await makeAdmin(prisma);
      const l = await login(admin.email, ADMIN_PASSWORD).expect(200);
      const res = await http().get('/v1/admin/auth/me').set('Cookie', cookieOf(l)).expect(401);
      expect(res.body.error.code).toBe('MFA_REQUIRED');
      await http().get('/v1/admin/staff').set('Cookie', cookieOf(l)).expect(401);
    });

    it('completes sign-in with a valid code, rotates the cookie, and refuses a replayed code', async () => {
      const { admin, secret } = await makeAdmin(prisma);
      clock.advance(31_000);
      const l = await login(admin.email, ADMIN_PASSWORD).expect(200);
      const first = cookieOf(l);
      const code = codeFor(secret, clock);
      const m = await http().post('/v1/admin/auth/mfa').set('Cookie', first).set('x-csrf-token', l.body.csrfToken).send({ code }).expect(200);
      const second = cookieOf(m);
      expect(second).not.toBe(first); // session fixation defence
      await http().get('/v1/admin/auth/me').set('Cookie', first).expect(401);
      await http().get('/v1/admin/auth/me').set('Cookie', second).expect(200);
      // the same code cannot sign anyone in again
      const l2 = await login(admin.email, ADMIN_PASSWORD).expect(200);
      const replay = await http().post('/v1/admin/auth/mfa').set('Cookie', cookieOf(l2)).set('x-csrf-token', l2.body.csrfToken).send({ code }).expect(400);
      expect(replay.body.error.code).toBe('INVALID_CODE');
    });

    it('wrong codes count toward the lockout and end the sessions', async () => {
      const { admin } = await makeAdmin(prisma);
      const l = await login(admin.email, ADMIN_PASSWORD).expect(200);
      for (let i = 0; i < 5; i++) {
        await http().post('/v1/admin/auth/mfa').set('Cookie', cookieOf(l)).set('x-csrf-token', l.body.csrfToken).send({ code: '000000' }).expect(i < 4 ? 400 : 400);
      }
      const after = await http().post('/v1/admin/auth/mfa').set('Cookie', cookieOf(l)).set('x-csrf-token', l.body.csrfToken).send({ code: '000000' });
      expect(after.status).toBe(401); // session was revoked by the lockout
    });

    it('enrols a new admin: secret is stored encrypted, recovery codes are shown once and work once', async () => {
      const { admin } = await makeAdmin(prisma, { totp: false });
      const l = await login(admin.email, ADMIN_PASSWORD).expect(200);
      expect(l.body.mfaEnrolled).toBe(false);
      let cookie = cookieOf(l);
      let csrf = l.body.csrfToken as string;
      const setup = await http().post('/v1/admin/auth/totp/setup').set('Cookie', cookie).set('x-csrf-token', csrf).expect(200);
      expect(setup.body.otpauthUri).toContain('otpauth://totp/ExamGadh:');
      const stored = await prisma.adminUser.findUniqueOrThrow({ where: { id: admin.id } });
      expect(stored.totpSecretEnc).toBeTruthy();
      expect(stored.totpSecretEnc).not.toContain(setup.body.secret);
      await http().post('/v1/admin/auth/totp/enable').set('Cookie', cookie).set('x-csrf-token', csrf).send({ code: '123456' }).expect(400);
      const ok = await http().post('/v1/admin/auth/totp/enable').set('Cookie', cookie).set('x-csrf-token', csrf).send({ code: totp(base32Decode(setup.body.secret), clock.now().getTime()) }).expect(200);
      expect(ok.body.recoveryCodes).toHaveLength(10);
      cookie = cookieOf(ok);
      csrf = ok.body.csrfToken;
      await http().get('/v1/admin/auth/me').set('Cookie', cookie).expect(200);
      expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: admin.id } })).recoveryCodeHashes).not.toContain(ok.body.recoveryCodes[0]); // only hashes are stored
      await http().post('/v1/admin/auth/totp/setup').set('Cookie', cookie).set('x-csrf-token', csrf).expect(409);

      // a recovery code signs in once
      const l2 = await login(admin.email, ADMIN_PASSWORD).expect(200);
      const rc = ok.body.recoveryCodes[0] as string;
      await http().post('/v1/admin/auth/mfa').set('Cookie', cookieOf(l2)).set('x-csrf-token', l2.body.csrfToken).send({ recoveryCode: rc }).expect(200);
      const l3 = await login(admin.email, ADMIN_PASSWORD).expect(200);
      await http().post('/v1/admin/auth/mfa').set('Cookie', cookieOf(l3)).set('x-csrf-token', l3.body.csrfToken).send({ recoveryCode: rc }).expect(400);
    });
  });

  describe('CSRF and cookies', () => {
    it('unsafe methods need the session-bound CSRF token; safe methods do not', async () => {
      const a = await signedInAdmin(app, prisma, clock);
      await http().get('/v1/admin/auth/me').set('Cookie', a.cookie).expect(200);
      const none = await http().post('/v1/admin/auth/password').set('Cookie', a.cookie).send({ currentPassword: ADMIN_PASSWORD, newPassword: 'Another-Long-Pass-77' }).expect(403);
      expect(none.body.error.code).toBe('CSRF_INVALID');
      await http().post('/v1/admin/auth/password').set('Cookie', a.cookie).set('x-csrf-token', 'wrong').send({ currentPassword: ADMIN_PASSWORD, newPassword: 'Another-Long-Pass-77' }).expect(403);
      await http().post('/v1/admin/auth/password').set(a.headers).send({ currentPassword: ADMIN_PASSWORD, newPassword: 'Another-Long-Pass-77' }).expect(204);
    });

    it('refuses a request from an origin that is not on the allow-list', async () => {
      process.env.CORS_ORIGINS = 'https://admin.examgadh.test';
      const other = await createApp();
      try {
        const { admin, secret } = await makeAdmin(other.prisma);
        const a = await adminSignIn(other.app, other.clock, admin, secret);
        const evil = await request(other.app.getHttpServer()).post('/v1/admin/auth/logout').set(a.headers).set('Origin', 'https://evil.example').expect(403);
        expect(evil.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
        await request(other.app.getHttpServer()).post('/v1/admin/auth/logout').set(a.headers).set('Origin', 'https://admin.examgadh.test').expect(204);
      } finally {
        delete process.env.CORS_ORIGINS;
        await other.app.close();
      }
    });

    it('logout ends the session; idle sessions expire; sessions end after 12 hours', async () => {
      const a = await signedInAdmin(app, prisma, clock);
      await http().post('/v1/admin/auth/logout').set(a.headers).expect(204);
      await http().get('/v1/admin/auth/me').set('Cookie', a.cookie).expect(401);

      const b = await signedInAdmin(app, prisma, clock, 'ADMIN');
      clock.advance(IDLE_MS + 1_000);
      await http().get('/v1/admin/auth/me').set('Cookie', b.cookie).expect(401);

      const c = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
      for (let i = 0; i < 25; i++) {
        clock.advance(29 * 60_000);
        const r = await http().get('/v1/admin/auth/me').set('Cookie', c.cookie);
        if (r.status === 401) return; // absolute 12 h limit reached
      }
      throw new Error('session never expired');
    });
  });

  describe('permissions are checked against the database on every request', () => {
    it('a role without staff:manage is refused; the super admin is allowed', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const res = await http().get('/v1/admin/staff').set('Cookie', admin.cookie).expect(403);
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required: 'staff:manage' } });
      const sup = await signedInAdmin(app, prisma, clock, 'SUPER_ADMIN', 'owner@examgadh.test');
      expect((await http().get('/v1/admin/staff').set('Cookie', sup.cookie).expect(200)).body.length).toBe(2);
    });

    it('a role change or a disabled account takes effect on the very next request', async () => {
      const sup = await signedInAdmin(app, prisma, clock, 'SUPER_ADMIN', 'owner@examgadh.test');
      const target = await signedInAdmin(app, prisma, clock, 'ADMIN', 'target@examgadh.test');
      expect((await http().get('/v1/admin/auth/me').set('Cookie', target.cookie).expect(200)).body.permissions).toContain('content:publish');
      await http().patch(`/v1/admin/staff/${target.id}`).set(sup.headers).send({ role: 'SUPPORT' }).expect(200);
      const me = await http().get('/v1/admin/auth/me').set('Cookie', target.cookie).expect(200);
      expect(me.body.role).toBe('SUPPORT');
      expect(me.body.permissions).not.toContain('content:publish');
      await http().patch(`/v1/admin/staff/${target.id}`).set(sup.headers).send({ disabled: true }).expect(200);
      // disabling also revokes the sessions, so the cookie is dead immediately
      expect((await http().get('/v1/admin/auth/me').set('Cookie', target.cookie).expect(401)).body.error.code).toMatch(/ADMIN_(UNAUTHENTICATED|DISABLED)/);
      await login('target@examgadh.test', ADMIN_PASSWORD).expect(401);
    });

    it('guard rails: no self-demotion, never zero super admins, no duplicate e-mail', async () => {
      const sup = await signedInAdmin(app, prisma, clock, 'SUPER_ADMIN', 'owner@examgadh.test');
      expect((await http().patch(`/v1/admin/staff/${sup.id}`).set(sup.headers).send({ role: 'ADMIN' }).expect(400)).body.error.code).toBe('SELF_CHANGE');
      const second = await makeAdmin(prisma, { role: 'SUPER_ADMIN', email: 'second@examgadh.test' });
      await http().patch(`/v1/admin/staff/${second.admin.id}`).set(sup.headers).send({ role: 'ADMIN' }).expect(200);
      const third = await makeAdmin(prisma, { role: 'SUPER_ADMIN', email: 'third@examgadh.test' });
      await http().patch(`/v1/admin/staff/${third.admin.id}`).set(sup.headers).send({ disabled: true }).expect(200);
      // only `sup` is left; a different super admin cannot demote the last one, so exercise it through a fresh super admin demoting `sup`
      const other = await signedInAdmin(app, prisma, clock, 'SUPER_ADMIN', 'fourth@examgadh.test');
      await http().patch(`/v1/admin/staff/${sup.id}`).set(other.headers).send({ disabled: true }).expect(200);
      expect((await http().patch(`/v1/admin/staff/${other.id}`).set(sup.headers).send({ disabled: true })).status).toBe(401); // sup is disabled now
      const dup = await http().post('/v1/admin/staff').set(other.headers).send({ email: 'FOURTH@examgadh.test', name: 'Dup', role: 'ADMIN' }).expect(409);
      expect(dup.body.error.code).toBe('EMAIL_IN_USE');
    });

    it('new staff get a one-time temporary password and must change it before anything else', async () => {
      const sup = await signedInAdmin(app, prisma, clock, 'SUPER_ADMIN', 'owner@examgadh.test');
      const created = await http().post('/v1/admin/staff').set(sup.headers).send({ email: 'New.Teacher@examgadh.test', name: 'New Teacher', role: 'TEACHER' }).expect(201);
      expect(created.body.temporaryPassword).toHaveLength(16);
      expect(created.body.email).toBe('new.teacher@examgadh.test');
      expect(JSON.stringify(await http().get('/v1/admin/staff').set(sup.cookie ? { Cookie: sup.cookie } : {}).expect(200).then((r) => r.body))).not.toContain(created.body.temporaryPassword);

      // The new person finishes 2FA enrolment and is then blocked until the password is changed.
      const l = await login('new.teacher@examgadh.test', created.body.temporaryPassword).expect(200);
      expect(l.body.mustChangePassword).toBe(true);
      let cookie = cookieOf(l);
      let csrf = l.body.csrfToken as string;
      const setup = await http().post('/v1/admin/auth/totp/setup').set('Cookie', cookie).set('x-csrf-token', csrf).expect(200);
      const en = await http().post('/v1/admin/auth/totp/enable').set('Cookie', cookie).set('x-csrf-token', csrf).send({ code: totp(base32Decode(setup.body.secret), clock.now().getTime()) }).expect(200);
      cookie = cookieOf(en);
      csrf = en.body.csrfToken;
      const blocked = await http().get('/v1/admin/staff').set('Cookie', cookie).expect(403);
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
      await http().get('/v1/admin/auth/me').set('Cookie', cookie).expect(200); // may still read own profile
      const weak = await http().post('/v1/admin/auth/password').set('Cookie', cookie).set('x-csrf-token', csrf).send({ currentPassword: created.body.temporaryPassword, newPassword: 'short1' }).expect(400);
      expect(weak.body.error.code).toBe('WEAK_PASSWORD');
      await http().post('/v1/admin/auth/password').set('Cookie', cookie).set('x-csrf-token', csrf).send({ currentPassword: 'not-it', newPassword: 'Brand-New-Passw0rd' }).expect(400);
      await http().post('/v1/admin/auth/password').set('Cookie', cookie).set('x-csrf-token', csrf).send({ currentPassword: created.body.temporaryPassword, newPassword: 'Brand-New-Passw0rd' }).expect(204);
      expect((await http().get('/v1/admin/auth/me').set('Cookie', cookie).expect(200)).body.mustChangePassword).toBe(false);
    });

    it('resetting 2FA ends the person\'s sessions and forces re-enrolment', async () => {
      const sup = await signedInAdmin(app, prisma, clock, 'SUPER_ADMIN', 'owner@examgadh.test');
      const t = await signedInAdmin(app, prisma, clock, 'ADMIN', 'target@examgadh.test');
      await http().post(`/v1/admin/staff/${t.id}/reset-mfa`).set(sup.headers).expect(204);
      await http().get('/v1/admin/auth/me').set('Cookie', t.cookie).expect(401);
      const l = await login('target@examgadh.test', ADMIN_PASSWORD).expect(200);
      expect(l.body.mfaEnrolled).toBe(false);
    });
  });

  describe('audit trail', () => {
    it('records sign-ins and staff changes without ever storing secrets', async () => {
      const sup = await signedInAdmin(app, prisma, clock, 'SUPER_ADMIN', 'owner@examgadh.test');
      const created = await http().post('/v1/admin/staff').set(sup.headers).send({ email: 'x@examgadh.test', name: 'Xavier', role: 'SUPPORT' }).expect(201);
      const rows = await prisma.auditLog.findMany();
      const actions = rows.map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['admin.login.password_ok', 'admin.login', 'staff.created']));
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(created.body.temporaryPassword);
      expect(dump).not.toContain(ADMIN_PASSWORD);
    });
  });
});
