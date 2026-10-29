import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { NotificationJobs } from '../src/modules/notifications/notification-jobs';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { baseTaxonomy, makeTest } from './fixtures';
import { adminSignIn, bearer, createApp, FakeClock, login, makeAdmin, resetDb, signedInAdmin } from './helpers';

describe('notifications, doubts desk, study planner', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clock: FakeClock;
  let jobs: NotificationJobs;
  let settings: SettingsService;
  beforeAll(async () => {
    ({ app, prisma, clock } = await createApp());
    jobs = app.get(NotificationJobs);
    settings = app.get(SettingsService);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    clock.reset();
    await resetDb(prisma);
    settings.clearCache();
    await baseTaxonomy(prisma);
    await prisma.paperSubject.create({ data: { paperId: 'cgpsc_pre_gs', subjectCode: 'S1' } });
    await prisma.plan.create({ data: { id: 'pass', nameEn: 'Pass', nameHi: 'पास', prices: { '3': 1 } } });
  });
  const http = () => request(app.getHttpServer());
  async function student(sub = 'stu', name = 'Asha Verma') {
    const r = await login(app, sub, `device-${sub}-1`, 'android', name);
    return { h: bearer(r.body.accessToken), id: r.body.user.id as string };
  }
  /** Admin sessions idle out after 30 minutes of fake time, so tests that move the clock sign in again right before use. */
  async function staffLogin(role: 'TEACHER' | 'SUPPORT' = 'TEACHER') {
    const a = await makeAdmin(prisma, { role, email: `${role.toLowerCase()}-staff@examgadh.test` });
    return () => adminSignIn(app, clock, a.admin, a.secret);
  }
  const grant = (userId: string, ms = 30 * 86_400_000) => prisma.entitlement.create({ data: { userId, planId: 'pass', endsAt: new Date(clock.now().getTime() + ms), source: 'admin' } });

  it('every route needs the right sign-in', async () => {
    for (const p of ['/v1/notifications', '/v1/notifications/unread-count', '/v1/doubts', '/v1/doubts/quota', '/v1/mentor', '/v1/mentor/today']) expect((await http().get(p)).status).toBe(401);
    for (const p of ['/v1/admin/doubts', '/v1/admin/doubts/stats', '/v1/admin/mentor/requests']) expect((await http().get(p)).status).toBe(401);
  });

  describe('notifications', () => {
    it('lists, counts, and marks notifications read; one student cannot touch another\'s', async () => {
      const a = await student('a');
      const b = await student('b');
      const svc = app.get(NotificationJobs)['notifications'];
      await svc.notify({ userId: a.id, kind: 'doubt_answered', dedupeKey: 'd1' });
      await svc.notify({ userId: a.id, kind: 'study_plan_ready', vars: { date: '2026-12-01' }, dedupeKey: 'p1' });
      await svc.notify({ userId: b.id, kind: 'doubt_answered', dedupeKey: 'd1' });
      expect((await http().get('/v1/notifications/unread-count').set(a.h)).body).toEqual({ unread: 2 });
      const list = (await http().get('/v1/notifications').set(a.h).expect(200)).body;
      expect(list.items).toHaveLength(2);
      expect(list.items.find((n: { kind: string }) => n.kind === 'study_plan_ready').bodyEn).toContain('2026-12-01');
      expect(list.items[0].titleHi).toBeTruthy();
      const id = list.items[0].id;
      await http().post(`/v1/notifications/${id}/read`).set(b.h).expect(404);
      await http().post(`/v1/notifications/${id}/read`).set(a.h).expect(204);
      await http().post(`/v1/notifications/${id}/read`).set(a.h).expect(204); // repeat is fine
      expect((await http().get('/v1/notifications?unread=true').set(a.h)).body.items).toHaveLength(1);
      expect((await http().post('/v1/notifications/read-all').set(a.h).expect(200)).body).toEqual({ updated: 1 });
      expect((await http().get('/v1/notifications/unread-count').set(b.h)).body).toEqual({ unread: 1 });
    });

    it('result-ready is sent once when the release time passes, never for early viewers or personal sets', async () => {
      const s = await student();
      const release = new Date(clock.now().getTime() + 2 * 3_600_000);
      const t = await makeTest(prisma, { n: 4, resultReleaseAt: release });
      const a = (await http().post(`/v1/tests/${t.testId}/attempts`).set(s.h).set('x-client-id', 'tab').send({}).expect(200)).body;
      await http().post(`/v1/attempts/${a.attemptId}/submit`).set(s.h).send({ submitKey: 'k' }).expect(200);
      expect(await jobs.resultsReleased()).toBe(0); // not released yet
      clock.advance(3 * 3_600_000);
      expect(await jobs.resultsReleased()).toBe(1);
      expect(await jobs.resultsReleased()).toBe(0); // second run: no duplicate
      const n = (await http().get('/v1/notifications').set(s.h)).body.items;
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ kind: 'result_ready', data: { attemptId: a.attemptId } });
    });

    it('plan-expiry reminders go once, only to students without a later renewal, and respect the daily cap', async () => {
      const a = await student('a');
      const b = await student('b');
      const c = await student('c');
      await grant(a.id, 2 * 86_400_000);
      await grant(b.id, 2 * 86_400_000);
      await grant(b.id, 40 * 86_400_000); // renewed
      await grant(c.id, 20 * 86_400_000); // far from expiry
      expect(await jobs.plansExpiring()).toBe(1);
      expect(await jobs.plansExpiring()).toBe(0);
      expect((await http().get('/v1/notifications').set(a.h)).body.items[0]).toMatchObject({ kind: 'plan_expiring' });
      expect((await http().get('/v1/notifications/unread-count').set(b.h)).body.unread).toBe(0);

      await settings.set('notifications.dailyCap', 1);
      const svc = app.get(NotificationJobs)['notifications'];
      await svc.notify({ userId: c.id, kind: 'announcement', vars: { title: 'T', body: 'B' }, dedupeKey: 'x1' });
      expect(await svc.notify({ userId: c.id, kind: 'announcement', vars: { title: 'T2', body: 'B' }, dedupeKey: 'x2' })).toBe(false); // over the cap
      expect(await svc.notify({ userId: c.id, kind: 'doubt_answered', dedupeKey: 'x3' })).toBe(true); // answers to your own actions are never capped
    });

    it('live-test reminders go to students whose target exam matches, 30 minutes before', async () => {
      const a = await student('a');
      const b = await student('b');
      await prisma.user.update({ where: { id: a.id }, data: { targetExam: 'cgpsc' } });
      const start = new Date(clock.now().getTime() + 20 * 60_000);
      await makeTest(prisma, { n: 4, mode: 'live', kind: 'live', startsAt: start, endsAt: new Date(start.getTime() + 3_600_000), title: 'Sunday live' });
      expect(await jobs.liveSoon()).toBe(1);
      expect(await jobs.liveSoon()).toBe(0);
      expect((await http().get('/v1/notifications').set(a.h)).body.items[0].bodyEn).toContain('Sunday live');
      expect((await http().get('/v1/notifications/unread-count').set(b.h)).body.unread).toBe(0);
    });

    it('an admin template overrides the built-in wording and placeholders are plain text', async () => {
      const s = await student();
      await prisma.notificationTemplate.create({ data: { key: 'doubt_answered', titleEn: 'Reply for {{name}}', titleHi: 'उत्तर {{name}}', bodyEn: 'Hi', bodyHi: 'नमस्ते' } });
      await app.get(NotificationJobs)['notifications'].notify({ userId: s.id, kind: 'doubt_answered', vars: { name: '<b>Asha</b>' }, dedupeKey: 'k' });
      expect((await http().get('/v1/notifications').set(s.h)).body.items[0].titleEn).toBe('Reply for <b>Asha</b>'); // stored as text; clients render text, never HTML
    });
  });

  describe('doubts desk', () => {
    const ask = (h: Record<string, string>, body: object = {}) => http().post('/v1/doubts').set(h).send({ text: 'Why is the answer B here?', ...body });

    it('a student asks, sees the thread and the SLA, and cannot see others\' doubts', async () => {
      const s = await student();
      const o = await student('o');
      const d = (await ask(s.h).expect(201)).body;
      expect(d.status).toBe('open');
      expect(new Date(d.slaDueAt).getTime() - clock.now().getTime()).toBe(48 * 3_600_000);
      const thread = (await http().get(`/v1/doubts/${d.id}`).set(s.h).expect(200)).body;
      expect(thread.messages).toHaveLength(1);
      expect(thread.messages[0]).toMatchObject({ from: 'student', text: 'Why is the answer B here?' });
      await http().get(`/v1/doubts/${d.id}`).set(o.h).expect(404);
      expect((await http().get('/v1/doubts').set(o.h)).body.total).toBe(0);
      expect((await http().get('/v1/doubts').set(s.h)).body.items[0]).toMatchObject({ id: d.id, messages: 1 });
      await ask(s.h, { text: 'hi' }).expect(400); // too short
      await ask(s.h, { contextType: 'question', contextId: '00000000-0000-4000-8000-000000000000' }).expect(400);
    });

    it('enforces 3 a day, and 2 a month for free students; plans lift the monthly limit', async () => {
      const s = await student();
      await ask(s.h).expect(201);
      await ask(s.h).expect(201);
      expect((await ask(s.h).expect(403)).body.error.code).toBe('DOUBT_FREE_QUOTA');
      expect((await http().get('/v1/doubts/quota').set(s.h)).body).toMatchObject({ paid: false, daily: { limit: 3, used: 2 }, monthly: { limit: 2, used: 2 } });
      await grant(s.id);
      await ask(s.h).expect(201);
      expect((await ask(s.h).expect(429)).body.error.code).toBe('DOUBT_DAILY_QUOTA');
      clock.advance(86_400_000); // next day
      await ask(s.h).expect(201);
    });

    it('shows similar answered FAQs before asking', async () => {
      const s = await student();
      await prisma.faq.create({ data: { keywords: 'refund payment money', qEn: 'How do I get a refund?', qHi: 'रिफंड कैसे मिलेगा?', aEn: 'Write to support.', aHi: 'सहायता को लिखें।' } });
      await prisma.faq.create({ data: { keywords: 'leaderboard', qEn: 'What is the leaderboard?', qHi: 'लीडरबोर्ड क्या है?', aEn: 'Ranks.', aHi: 'रैंक।' } });
      const r = (await http().get('/v1/doubts/similar?q=how to get my refund').set(s.h).expect(200)).body;
      expect(r[0].qEn).toContain('refund');
      await http().get('/v1/doubts/similar?q=hi').set(s.h).expect(400);
    });

    it('attachments: students get upload links in their own folder and cannot attach someone else\'s files', async () => {
      const s = await student();
      const o = await student('o');
      const p = (await http().post('/v1/doubts/uploads/presign').set(s.h).send({ purpose: 'doubt-image', contentType: 'image/png' }).expect(200)).body;
      expect(p.key.startsWith(`doubts/${s.id}/`)).toBe(true);
      await http().post('/v1/doubts/uploads/presign').set(s.h).send({ purpose: 'doubt-image', contentType: 'application/pdf' }).expect(400);
      await http().post('/v1/doubts/uploads/presign').set(s.h).send({ purpose: 'question-image', contentType: 'image/png' }).expect(400);
      const d = (await ask(s.h, { attachmentKeys: [p.key] }).expect(201)).body;
      const m = (await http().get(`/v1/doubts/${d.id}`).set(s.h)).body.messages[0];
      expect(m.attachments[0].key).toBe(p.key);
      expect(m.attachments[0].url).toContain('X-Amz-Signature');
      expect((await ask(o.h, { attachmentKeys: [p.key] }).expect(400)).body.error.code).toBe('INVALID_ATTACHMENT');
      await ask(o.h, { attachmentKeys: ['doubts/../secret'] }).expect(400);
    });

    it('staff answer, the student is notified, can rate, reopen with a follow-up, and close', async () => {
      const login = await staffLogin();
      const s = await student();
      const d = (await ask(s.h).expect(201)).body;
      await http().post(`/v1/doubts/${d.id}/rating`).set(s.h).send({ rating: 5 }).expect(409); // not answered yet
      clock.advance(3_600_000);
      let teacher = await login();
      await http().post(`/v1/admin/doubts/${d.id}/reply`).set(teacher.headers).send({ text: 'Option B because ...' }).expect(204);
      let t = (await http().get(`/v1/doubts/${d.id}`).set(s.h)).body;
      expect(t).toMatchObject({ status: 'answered' });
      expect(t.messages[1]).toMatchObject({ from: 'staff', text: 'Option B because ...' });
      expect(t.firstResponseAt).toBeTruthy();
      expect((await http().get('/v1/notifications').set(s.h)).body.items[0].kind).toBe('doubt_answered');
      await http().post(`/v1/doubts/${d.id}/rating`).set(s.h).send({ rating: 4 }).expect(204);
      await http().post(`/v1/doubts/${d.id}/rating`).set(s.h).send({ rating: 6 }).expect(400);

      clock.advance(3_600_000);
      t = (await http().post(`/v1/doubts/${d.id}/messages`).set(s.h).send({ text: 'Still not clear' }).expect(201)).body;
      expect(t).toMatchObject({ status: 'open', reopened: true });
      expect(new Date(t.slaDueAt).getTime()).toBe(clock.now().getTime() + 48 * 3_600_000); // SLA restarts
      teacher = await login();
      await http().post(`/v1/admin/doubts/${d.id}/reply`).set(teacher.headers).send({ text: 'Let me explain again', close: true }).expect(204);
      expect((await http().get(`/v1/doubts/${d.id}`).set(s.h)).body.status).toBe('closed');
      expect((await http().post(`/v1/doubts/${d.id}/messages`).set(s.h).send({ text: 'one more' }).expect(409)).body.error.code).toBe('DOUBT_CLOSED');
      await http().post(`/v1/admin/doubts/${d.id}/reply`).set(teacher.headers).send({ text: 'late' }).expect(409);
    });

    it('admin inbox: filters by SLA, status, abuse and text; stats show median response and SLA hit rate', async () => {
      const login = await staffLogin();
      const s = await student('s', 'Rohit Sahu');
      const first = (await ask(s.h, { text: 'Question about polity' }).expect(201)).body;
      const second = (await ask(s.h, { text: 'Question about history' }).expect(201)).body;
      clock.advance(2 * 3_600_000);
      let teacher = await login();
      await http().post(`/v1/admin/doubts/${first.id}/reply`).set(teacher.headers).send({ text: 'ok' }).expect(204);
      clock.advance(47 * 3_600_000); // second is now past its 48h SLA
      teacher = await login();
      const get = (qs: string) => http().get(`/v1/admin/doubts?${qs}`).set(teacher.headers).expect(200).then((r) => r.body);
      expect((await get('sla=overdue')).items.map((d: { id: string }) => d.id)).toEqual([second.id]);
      expect((await get('status=answered')).total).toBe(1);
      expect((await get('q=history')).total).toBe(1);
      expect((await get('q=rohit')).total).toBe(2);
      await http().post(`/v1/admin/doubts/${second.id}/abuse`).set(teacher.headers).send({ abuse: true }).expect(204);
      expect((await get('abuse=true')).items[0].id).toBe(second.id);
      const st = (await http().get('/v1/admin/doubts/stats').set(teacher.headers).expect(200)).body;
      expect(st).toMatchObject({ asked: 2, overdue: 1, abuseFlagged: 1, medianFirstResponseHours: 2, withinSlaPct: 100, byStatus: { answered: 1, open: 1 } });
      const detail = (await http().get(`/v1/admin/doubts/${first.id}`).set(teacher.headers).expect(200)).body;
      expect(detail.student).toMatchObject({ name: 'Rohit Sahu' });
      expect(JSON.stringify(detail)).not.toContain('googleSub');
      await http().post(`/v1/admin/doubts/${second.id}/close`).set(teacher.headers).expect(204);
      expect(await prisma.auditLog.count({ where: { action: { in: ['doubt.reply', 'doubt.flag-abuse', 'doubt.close'] } } })).toBe(3);
    });

    it('permissions: support can read but not answer; content editors cannot see doubts', async () => {
      const support = await signedInAdmin(app, prisma, clock, 'SUPPORT');
      const editor = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
      const s = await student();
      const d = (await ask(s.h).expect(201)).body;
      await http().get('/v1/admin/doubts').set(support.headers).expect(200);
      await http().post(`/v1/admin/doubts/${d.id}/reply`).set(support.headers).send({ text: 'hello' }).expect(403);
      await http().get('/v1/admin/doubts').set(editor.headers).expect(403);
    });
  });

  describe('study planner', () => {
    const req = (h: Record<string, string>, body: object = {}) => http().post('/v1/mentor/requests').set(h).send({ examId: 'cgpsc', hoursPerDay: 4, examDate: '2027-01-20', ...body });

    it('a request creates a draft the student cannot see until the mentor sends it', async () => {
      const s = await student();
      const r = (await req(s.h).expect(201)).body;
      expect(r).toMatchObject({ status: 'open', plan: null, examDate: '2027-01-20' });
      expect((await req(s.h).expect(409)).body.error.code).toBe('MENTOR_REQUEST_OPEN');
      const stored = await prisma.mentorRequest.findUniqueOrThrow({ where: { id: r.id } });
      expect((stored.plan as { weeks: unknown[] }).weeks.length).toBeGreaterThan(5);
      expect((await http().get('/v1/mentor').set(s.h)).body.requests[0].plan).toBeNull();
      expect((await http().get('/v1/mentor/today').set(s.h)).body.plan).toBeNull();
    });

    it('validates exam, hours and date', async () => {
      const s = await student();
      await req(s.h, { examId: 'nope' }).expect(400);
      await req(s.h, { hoursPerDay: 0 }).expect(400);
      await req(s.h, { hoursPerDay: 20 }).expect(400);
      await req(s.h, { examDate: '2020-01-01' }).expect(400);
      await req(s.h, { examDate: '2031-01-01' }).expect(400);
      await req(s.h, { examDate: 'soon' }).expect(400);
      await req(s.h, { examDate: undefined }).expect(201); // no date: a 12-week plan
    });

    it('puts a student\'s weak topics first when the plan is drafted', async () => {
      const s = await student();
      await prisma.userTopicStat.createMany({ data: [{ userId: s.id, topicCode: 'T1', attempted: 20, correct: 18 }, { userId: s.id, topicCode: 'T2', attempted: 20, correct: 3 }] });
      const r = (await req(s.h).expect(201)).body;
      const plan = (await prisma.mentorRequest.findUniqueOrThrow({ where: { id: r.id } })).plan as { weeks: Array<{ focus: Array<{ topicCode: string }> }> };
      expect(plan.weeks[0].focus[0].topicCode).toBe('T2');
    });

    it('the mentor reviews, edits, regenerates and sends; the student then sees today\'s tasks and is notified', async () => {
      const teacher = await signedInAdmin(app, prisma, clock, 'TEACHER');
      const s = await student();
      const r = (await req(s.h).expect(201)).body;
      const list = (await http().get('/v1/admin/mentor/requests?status=open').set(teacher.headers).expect(200)).body;
      expect(list.items[0]).toMatchObject({ id: r.id, student: { name: 'Asha Verma' } });
      const detail = (await http().get(`/v1/admin/mentor/requests/${r.id}`).set(teacher.headers).expect(200)).body;
      expect(detail.plan.weeks.length).toBeGreaterThan(0);
      expect(detail.topicAccuracy.map((t: { topicCode: string }) => t.topicCode).sort()).toEqual(['T1', 'T2']);

      const edited = structuredClone(detail.plan);
      edited.weeks[0].days[0].tasks[0].titleEn = 'Start with <script>x</script>Polity basics';
      await http().put(`/v1/admin/mentor/requests/${r.id}/plan`).set(teacher.headers).send(edited).expect(204);
      const saved = (await prisma.mentorRequest.findUniqueOrThrow({ where: { id: r.id } })).plan as { weeks: Array<{ days: Array<{ tasks: Array<{ titleEn: string }> }> }> };
      expect(saved.weeks[0].days[0].tasks[0].titleEn).not.toContain('<script>');
      await http().put(`/v1/admin/mentor/requests/${r.id}/plan`).set(teacher.headers).send({ weeks: [] }).expect(400);
      const regen = (await http().post(`/v1/admin/mentor/requests/${r.id}/regenerate`).set(teacher.headers).expect(200)).body;
      expect(regen.weeks[0].days[0].tasks[0].titleEn).not.toContain('Polity basics');

      await http().post(`/v1/admin/mentor/requests/${r.id}/send`).set(teacher.headers).expect(204);
      await http().post(`/v1/admin/mentor/requests/${r.id}/send`).set(teacher.headers).expect(409);
      await http().put(`/v1/admin/mentor/requests/${r.id}/plan`).set(teacher.headers).send(edited).expect(409);
      const mine = (await http().get('/v1/mentor').set(s.h)).body.requests[0];
      expect(mine.status).toBe('sent');
      expect(mine.plan.weeks.length).toBeGreaterThan(0);
      const today = (await http().get('/v1/mentor/today').set(s.h)).body;
      expect(today.day.tasks.length).toBeGreaterThan(0);
      expect(today.plan.requestId).toBe(r.id);
      expect((await http().get('/v1/notifications').set(s.h)).body.items[0].kind).toBe('study_plan_ready');
      await req(s.h).expect(201); // a new request is allowed once the previous plan is sent
      clock.advance(400 * 86_400_000);
      expect((await http().get('/v1/mentor/today').set(s.h)).body.day).toBeNull(); // plan is over
      expect(await prisma.auditLog.count({ where: { action: { startsWith: 'mentor.' } } })).toBe(3);
    });

    it('only mentors (teacher/admin) manage plans', async () => {
      const support = await signedInAdmin(app, prisma, clock, 'SUPPORT');
      await http().get('/v1/admin/mentor/requests').set(support.headers).expect(403);
      const teacher = await signedInAdmin(app, prisma, clock, 'TEACHER');
      await http().get('/v1/admin/mentor/requests/00000000-0000-4000-8000-000000000000').set(teacher.headers).expect(404);
    });
  });
});
