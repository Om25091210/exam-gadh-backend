import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { baseTaxonomy, makeTest } from './fixtures';
import { bearer, createApp, FakeClock, login, resetDb, signedInAdmin } from './helpers';

describe('admin: users, audit, settings, dashboard', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clock: FakeClock;
  beforeAll(async () => ({ app, prisma, clock } = await createApp()));
  afterAll(() => app.close());
  beforeEach(async () => {
    clock.reset();
    app.get(SettingsService).clearCache();
    await resetDb(prisma);
    await baseTaxonomy(prisma);
  });
  const http = () => request(app.getHttpServer());

  describe('students', () => {
    it('searches, filters, sorts and paginates, and never exposes phone or Google ids', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      for (const [i, n] of ['Asha Verma', 'Bharat Sahu', 'Chitra Netam', 'Deepak Sahu'].entries()) {
        await prisma.user.create({ data: { googleSub: `g${i}`, email: `u${i}@x.in`, name: n, district: i % 2 ? 'Raipur' : 'Bilaspur', phone: `98765432${i}0`, targetExam: i < 2 ? 'cgpsc' : null } });
      }
      const get = (qs: string) => http().get(`/v1/admin/users?${qs}`).set(admin.headers).expect(200).then((r) => r.body);
      expect((await get('')).total).toBe(4);
      expect((await get('q=sahu')).items.map((u: { name: string }) => u.name).sort()).toEqual(['Bharat Sahu', 'Deepak Sahu']);
      expect((await get('q=u2@x')).total).toBe(1);
      expect((await get('district=Raipur')).total).toBe(2);
      expect((await get('targetExam=cgpsc')).total).toBe(2);
      expect((await get('sort=name&pageSize=2&page=2')).items.map((u: { name: string }) => u.name)).toEqual(['Chitra Netam', 'Deepak Sahu']);
      expect((await get('paid=true')).total).toBe(0);
      const one = (await get('q=asha')).items[0];
      const detail = (await http().get(`/v1/admin/users/${one.id}`).set(admin.headers).expect(200)).body;
      expect(JSON.stringify(detail)).not.toContain('98765432');
      expect(JSON.stringify(detail)).not.toContain('googleSub');
      await http().get('/v1/admin/users/not-a-uuid').set(admin.headers).expect(400);
      await http().get('/v1/admin/users/00000000-0000-4000-8000-000000000000').set(admin.headers).expect(404);
      await http().get('/v1/admin/users?pageSize=500').set(admin.headers).expect(400);
    });

    it('support can look people up but not change anything; teachers cannot see students at all', async () => {
      const support = await signedInAdmin(app, prisma, clock, 'SUPPORT');
      const teacher = await signedInAdmin(app, prisma, clock, 'TEACHER');
      const u = await prisma.user.create({ data: { googleSub: 'g', email: 'a@x.in', name: 'A Student' } });
      await http().get('/v1/admin/users').set(support.headers).expect(200);
      await http().post(`/v1/admin/users/${u.id}/suspend`).set(support.headers).send({ reason: 'because' }).expect(403);
      await http().post(`/v1/admin/users/${u.id}/grant-access`).set(support.headers).send({ planId: 'p', days: 5 }).expect(403);
      await http().get('/v1/admin/users').set(teacher.headers).expect(403);
    });

    it('suspending ends the student session on the very next request, blocks sign-in, is audited, and can be undone', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const s = await login(app, 'stu');
      const h = bearer(s.body.accessToken);
      await http().get('/v1/me').set(h).expect(200);
      await http().post(`/v1/admin/users/${s.body.user.id}/suspend`).set(admin.headers).send({ reason: 'Shared account' }).expect(204);
      expect((await http().get('/v1/me').set(h).expect(401)).body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect((await login(app, 'stu')).body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect((await http().post(`/v1/admin/users/${s.body.user.id}/suspend`).set(admin.headers).send({ reason: 'again' }).expect(409)).body.error.code).toBe('ALREADY_SUSPENDED');
      await http().post(`/v1/admin/users/${s.body.user.id}/suspend`).set(admin.headers).send({ reason: '' }).expect(400);
      const list = (await http().get('/v1/admin/users?status=suspended').set(admin.headers).expect(200)).body;
      expect(list.total).toBe(1);
      await http().post(`/v1/admin/users/${s.body.user.id}/activate`).set(admin.headers).expect(204);
      expect((await http().post(`/v1/admin/users/${s.body.user.id}/activate`).set(admin.headers).expect(409)).body.error.code).toBe('NOT_SUSPENDED');
      const again = await login(app, 'stu');
      expect(again.status).toBe(200);
      const log = await prisma.auditLog.findMany({ where: { targetType: 'user', target: s.body.user.id }, orderBy: { createdAt: 'asc' } });
      expect(log.map((l) => l.action)).toEqual(['user.suspended', 'user.activated']);
      expect(log[0].meta).toMatchObject({ reason: 'Shared account' });
    });

    it('granting access unlocks paid content immediately and revoking locks it again', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const t = await makeTest(prisma, { access: 'paid' });
      await prisma.plan.create({ data: { id: 'pass', nameEn: 'Pass', nameHi: 'पास', prices: { '3': 1 } } });
      const s = await login(app, 'stu');
      const h = bearer(s.body.accessToken);
      await http().post(`/v1/tests/${t.testId}/attempts`).set(h).expect(403);
      expect((await http().post(`/v1/admin/users/${s.body.user.id}/grant-access`).set(admin.headers).send({ planId: 'nope', days: 5 }).expect(400)).body.error.code).toBe('UNKNOWN_PLAN');
      await http().post(`/v1/admin/users/${s.body.user.id}/grant-access`).set(admin.headers).send({ planId: 'pass', days: 0 }).expect(400);
      const grant = (await http().post(`/v1/admin/users/${s.body.user.id}/grant-access`).set(admin.headers).send({ planId: 'pass', days: 30, note: 'scholarship' }).expect(201)).body;
      expect(Math.round((new Date(grant.endsAt).getTime() - new Date(grant.startsAt).getTime()) / 864e5)).toBe(30);
      await http().post(`/v1/tests/${t.testId}/attempts`).set(h).expect(200);
      await http().post(`/v1/admin/users/entitlements/${grant.id}/revoke`).set(admin.headers).send({ reason: 'granted by mistake' }).expect(204);
      expect((await http().post(`/v1/admin/users/entitlements/${grant.id}/revoke`).set(admin.headers).send({ reason: 'again again' }).expect(409)).body.error.code).toBe('ALREADY_REVOKED');
      const detail = (await http().get(`/v1/admin/users/${s.body.user.id}`).set(admin.headers).expect(200)).body;
      expect(detail.entitlements[0]).toMatchObject({ source: 'admin' });
      expect(detail.entitlements[0].revokedAt).toBeTruthy();
      const actions = (await prisma.auditLog.findMany({ where: { target: s.body.user.id } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['user.access_granted', 'user.access_revoked']));
    });

    it('shows a student their attempts, topic accuracy and active sessions', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const t = await makeTest(prisma, { n: 4 });
      const s = await login(app, 'stu');
      const h = bearer(s.body.accessToken);
      const a = (await http().post(`/v1/tests/${t.testId}/attempts`).set(h).expect(200)).body;
      await http().post(`/v1/attempts/${a.attemptId}/submit`).set(h).send({ submitKey: 'k' }).expect(200);
      const d = (await http().get(`/v1/admin/users/${s.body.user.id}`).set(admin.headers).expect(200)).body;
      expect(d.attempts).toHaveLength(1);
      expect(d.attempts[0].result).toMatchObject({ maxScore: 8 });
      expect(d.activeSessions).toHaveLength(1);
      await http().post(`/v1/admin/users/${s.body.user.id}/revoke-sessions`).set(admin.headers).expect(204);
      await http().get('/v1/me').set(h).expect(401);
    });
  });

  describe('audit log', () => {
    it('is visible only with audit:read and filters by actor, action prefix, target and time', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const editor = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
      await http().post('/v1/admin/questions').set(editor.headers).send({ type: 'single', topicCode: 'T1', answer: 0, body: { en: { stem: 'Audit me', options: ['a', 'b', 'c', 'd'] } } }).expect(201);
      await http().get('/v1/admin/audit').set(editor.headers).expect(403);
      const all = (await http().get('/v1/admin/audit').set(admin.headers).expect(200)).body;
      expect(all.total).toBeGreaterThan(2);
      const q = (await http().get(`/v1/admin/audit?action=question.&actor=${editor.id}`).set(admin.headers).expect(200)).body;
      expect(q.items.map((i: { action: string }) => i.action)).toEqual(['question.created']);
      expect(q.items[0]).toMatchObject({ actorType: 'admin', targetType: 'question' });
      expect((await http().get('/v1/admin/audit?actorType=system').set(admin.headers).expect(200)).body.total).toBe(0);
      const future = new Date(Date.now() + 864e5).toISOString();
      expect((await http().get(`/v1/admin/audit?from=${future}`).set(admin.headers).expect(200)).body.total).toBe(0);
      await http().get('/v1/admin/audit?pageSize=1000').set(admin.headers).expect(400);
      expect(JSON.stringify(all)).not.toMatch(/passwordHash|totpSecret|recoveryCode/);
    });
  });

  describe('settings', () => {
    it('validates every value, applies it right away, and audits the change', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const editor = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
      await http().get('/v1/admin/settings').set(editor.headers).expect(403);
      const cur = (await http().get('/v1/admin/settings').set(admin.headers).expect(200)).body;
      expect(cur.values['attempt.multiClientPolicy']).toBe('takeover');
      const put = (k: string, value: unknown) => http().put(`/v1/admin/settings/${k}`).set(admin.headers).send({ value });
      expect((await put('attempt.multiClientPolicy', 'both').expect(400)).body.error.code).toBe('INVALID_VALUE');
      expect((await put('doubts.slaHours', 0).expect(400)).body.error.code).toBe('INVALID_VALUE');
      expect((await put('notifications.quietHours', [25, 7]).expect(400)).body.error.code).toBe('INVALID_VALUE');
      expect((await put('no.such.key', 1).expect(400)).body.error.code).toBe('UNKNOWN_SETTING');
      await put('attempt.multiClientPolicy', 'block').expect(200);
      await put('doubts.slaHours', 24).expect(200);
      const after = (await http().get('/v1/admin/settings').set(admin.headers).expect(200)).body;
      expect(after.values).toMatchObject({ 'attempt.multiClientPolicy': 'block', 'doubts.slaHours': 24 });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'setting.changed', target: 'attempt.multiClientPolicy' } });
      expect(log).toMatchObject({ before: { value: 'takeover' }, after: { value: 'block' } });
      // the engine really uses it: with "block" a second tab is refused
      const t = await makeTest(prisma);
      const s = await login(app, 'stu');
      await http().post(`/v1/tests/${t.testId}/attempts`).set(bearer(s.body.accessToken)).set('x-client-id', 'tab-1').expect(200);
      await http().post(`/v1/tests/${t.testId}/attempts`).set(bearer(s.body.accessToken)).set('x-client-id', 'tab-2').expect(409);
    });
  });

  describe('dashboard', () => {
    it('computes real metrics for the chosen range and rejects bad ranges', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const t = await makeTest(prisma, { n: 4 });
      const old = await prisma.user.create({ data: { googleSub: 'old', email: 'old@x.in', name: 'Old', createdAt: new Date(Date.now() - 90 * 864e5) } });
      await prisma.session.create({ data: { userId: old.id, deviceId: 'd', platform: 'web', refreshTokenHash: 'h', expiresAt: new Date(Date.now() + 864e5), lastSeenAt: new Date(Date.now() - 20 * 864e5) } });
      // the old student was last seen 20 days ago (inside the 30-day MAU window, outside the 7-day one);
      // two more are active today, one of them pays and finishes a test
      const a = await login(app, 'a');
      const b = await login(app, 'b');
      const att = (await http().post(`/v1/tests/${t.testId}/attempts`).set(bearer(a.body.accessToken)).expect(200)).body;
      await http().post(`/v1/attempts/${att.attemptId}/submit`).set(bearer(a.body.accessToken)).send({ submitKey: 'k' }).expect(200);
      await http().post(`/v1/tests/${t.testId}/attempts`).set(bearer(b.body.accessToken)).expect(200); // left running
      await prisma.plan.create({ data: { id: 'p', nameEn: 'P', nameHi: 'P', prices: { '3': 399 } } });
      const order = await prisma.order.create({ data: { userId: a.body.user.id, planId: 'p', months: 3, amountPaise: 39_900, razorpayOrderId: 'order_x', status: 'paid' } });
      await prisma.payment.create({ data: { orderId: order.id, razorpayPaymentId: 'pay_x', amountPaise: 39_900, status: 'captured' } });
      await prisma.entitlement.create({ data: { userId: a.body.user.id, planId: 'p', endsAt: new Date(Date.now() + 5 * 864e5), source: 'payment', orderId: order.id } });
      await prisma.order.create({ data: { userId: b.body.user.id, planId: 'p', months: 3, amountPaise: 39_900, razorpayOrderId: 'order_y', status: 'failed' } });

      const d = (await http().get('/v1/admin/dashboard').set(admin.headers).expect(200)).body;
      expect(d.students).toMatchObject({ total: 3, new: 2, paid: 1, dau: 2, wau: 2, mau: 3, suspended: 0 });
      expect(d.revenue).toMatchObject({ grossPaise: 39_900, refundedPaise: 0, netPaise: 39_900, payments: 1 });
      expect(d.attempts).toMatchObject({ started: 2, submitted: 1 });
      expect(d.attempts.avgScorePct).toBe(0);
      const today = d.series.at(-1);
      expect(today).toMatchObject({ signups: 2, active: 2, attempts: 2, revenuePaise: 39_900 });
      expect(d.series).toHaveLength(30);
      expect(d.alerts.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(['failed_payments', 'plans_expiring']));
      expect(d.alerts.find((x: { key: string }) => x.key === 'failed_payments').count).toBe(1);

      const wide = (await http().get(`/v1/admin/dashboard?from=${new Date(Date.now() - 120 * 864e5).toISOString()}`).set(admin.headers).expect(200)).body;
      expect(wide.students.new).toBe(3);
      expect(wide.series).toHaveLength(121);
      expect((await http().get(`/v1/admin/dashboard?from=${new Date(Date.now() + 864e5).toISOString()}`).set(admin.headers).expect(400)).body.error.code).toBe('INVALID_RANGE');
      expect((await http().get(`/v1/admin/dashboard?from=${new Date(Date.now() - 400 * 864e5).toISOString()}`).set(admin.headers).expect(400)).body.error.code).toBe('RANGE_TOO_LONG');
      await http().get('/v1/admin/dashboard?from=garbage').set(admin.headers).expect(400);
      const editor = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
      await http().get('/v1/admin/dashboard').set(editor.headers).expect(403);
    });

    it('shows an empty platform as zeros, not as errors', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const d = (await http().get('/v1/admin/dashboard').set(admin.headers).expect(200)).body;
      expect(d.students).toMatchObject({ total: 0, dau: 0, stickiness: null });
      expect(d.revenue.netPaise).toBe(0);
      expect(d.attempts.avgScorePct).toBeNull();
      expect(d.alerts).toEqual([]);
    });
  });
});
