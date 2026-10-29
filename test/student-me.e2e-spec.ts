import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { baseTaxonomy, makeQuestions, makeTest } from './fixtures';
import { bearer, createApp, FakeClock, login, resetDb } from './helpers';

describe('student: personal data', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clock: FakeClock;
  beforeAll(async () => ({ app, prisma, clock } = await createApp()));
  afterAll(() => app.close());
  beforeEach(async () => {
    clock.reset();
    await resetDb(prisma);
    await baseTaxonomy(prisma);
  });
  const http = () => request(app.getHttpServer());
  async function student(sub = 'stu', name = 'Asha Verma') {
    const r = await login(app, sub, `device-${sub}-1`, 'android', name);
    return { h: bearer(r.body.accessToken), id: r.body.user.id as string };
  }
  type T = Awaited<ReturnType<typeof makeTest>>;
  /** Takes a test: `pick(i)` is the option chosen for question i (null = skip). Returns the attempt id. */
  async function take(s: { h: Record<string, string> }, t: T, pick: (i: number) => number | null) {
    const a = (await http().post(`/v1/tests/${t.testId}/attempts`).set(s.h).set('x-client-id', 'tab').send({}).expect(200)).body;
    const answers = t.tvqIds.map((qid, i) => ({ qid, selected: pick(i), visited: true, timeSpentSec: 30, seq: 1 })).filter((x) => x.selected !== null);
    await http().put(`/v1/attempts/${a.attemptId}/state`).set(s.h).set('x-client-id', 'tab').send({ seq: 1, answers }).expect(200);
    await http().post(`/v1/attempts/${a.attemptId}/submit`).set(s.h).send({ submitKey: 'k' }).expect(200);
    return a.attemptId as string;
  }
  const right = (i: number) => i % 4; // question i has correct option i % 4
  const wrong = (i: number) => (i + 1) % 4;

  it('every personal-data route needs a signed-in student', async () => {
    for (const path of ['/v1/home', '/v1/me/analytics', '/v1/me/bookmarks', '/v1/me/notes', '/v1/me/revision', '/v1/leaderboard', '/v1/me/orders']) {
      expect((await http().get(path)).status).toBe(401);
    }
    expect((await http().post('/v1/practice').send({})).status).toBe(401);
  });

  describe('home', () => {
    it('shows an unfinished attempt to continue, then streak, trend and weak topics after tests', async () => {
      const s = await student();
      const t = await makeTest(prisma, { n: 10, title: 'Mock 1' });
      const a = (await http().post(`/v1/tests/${t.testId}/attempts`).set(s.h).set('x-client-id', 'tab').send({}).expect(200)).body;
      let home = (await http().get('/v1/home').set(s.h).expect(200)).body;
      expect(home.continue).toHaveLength(1);
      expect(home.continue[0]).toMatchObject({ attemptId: a.attemptId, titleEn: 'Mock 1', total: 10 });
      expect(home.streak).toEqual({ current: 0, activeToday: false });

      await http().post(`/v1/attempts/${a.attemptId}/submit`).set(s.h).send({ submitKey: 'k' }).expect(200);
      await take(s, await makeTest(prisma, { n: 10, title: 'Mock 2' }), wrong); // 5 wrong in each topic
      home = (await http().get('/v1/home').set(s.h).expect(200)).body;
      expect(home.continue).toHaveLength(0);
      expect(home.streak).toEqual({ current: 1, activeToday: true });
      expect(home.trend).toHaveLength(2);
      expect(home.trend[1]).toMatchObject({ titleEn: 'Mock 2', pct: expect.any(Number) });
      expect(home.weakTopics.map((w: { topicCode: string }) => w.topicCode).sort()).toEqual(['T1', 'T2']);
      expect(home.weakTopics[0]).toMatchObject({ attempted: 5, accuracyPct: 0 });
      expect(home.unreadNotifications).toBe(0);
      expect(home.plan).toMatchObject({ active: [], expiringSoon: false });
    });

    it('the streak continues on the next day and breaks after a missed day', async () => {
      const s = await student();
      await take(s, await makeTest(prisma, { n: 4 }), right);
      clock.advance(86_400_000);
      expect((await http().get('/v1/home').set(s.h)).body.streak).toEqual({ current: 1, activeToday: false });
      await take(s, await makeTest(prisma, { n: 4 }), right);
      expect((await http().get('/v1/home').set(s.h)).body.streak).toEqual({ current: 2, activeToday: true });
      clock.advance(3 * 86_400_000);
      expect((await http().get('/v1/home').set(s.h)).body.streak.current).toBe(0);
    });
  });

  describe('analytics', () => {
    it('with too few answers it only recommends a diagnostic; with data it names weak topics', async () => {
      const s = await student();
      let r = (await http().get('/v1/me/analytics').set(s.h).expect(200)).body;
      expect(r.insights[0]).toMatchObject({ kind: 'get_started' });
      await take(s, await makeTest(prisma, { n: 10 }), wrong);
      await take(s, await makeTest(prisma, { n: 10 }), wrong);
      r = (await http().get('/v1/me/analytics?days=30').set(s.h).expect(200)).body;
      expect(r.topics.find((t: { topicCode: string }) => t.topicCode === 'T1')).toMatchObject({ attempted: 10, correct: 0, strength: 'weak', avgTimeSec: 30 });
      expect(r.insights.filter((i: { kind: string }) => i.kind === 'weak_topic')).toHaveLength(2);
      expect(r.progress).toHaveLength(1);
      expect(r.marks.testsTaken).toBe(2);
      expect(r.marks.negativeDeducted).toBeGreaterThan(0);
      await http().get('/v1/me/analytics?days=3').set(s.h).expect(400);
    });

    it('does not count tests whose results are not released yet', async () => {
      const s = await student();
      await take(s, await makeTest(prisma, { n: 10, resultReleaseAt: new Date(clock.now().getTime() + 3_600_000) }), wrong);
      const r = (await http().get('/v1/me/analytics').set(s.h).expect(200)).body;
      expect(r.progress).toHaveLength(0);
      expect(r.time.rushedWrongAnswers).toBe(0);
    });
  });

  describe('bookmarks, notes, reports', () => {
    it('only questions from the student\'s own finished attempts can be saved; keys show once released', async () => {
      const s = await student();
      const other = await student('other');
      const t = await makeTest(prisma, { n: 4 });
      const a = (await http().post(`/v1/tests/${t.testId}/attempts`).set(s.h).set('x-client-id', 'tab').send({}).expect(200)).body;
      const ref = { attemptId: a.attemptId, qid: t.tvqIds[1] };
      await http().post('/v1/me/bookmarks').set(s.h).send({ kind: 'question', ...ref }).expect(404); // still running
      await http().post(`/v1/attempts/${a.attemptId}/submit`).set(s.h).send({ submitKey: 'k' }).expect(200);
      await http().post('/v1/me/bookmarks').set(other.h).send({ kind: 'question', ...ref }).expect(404); // not theirs
      await http().post('/v1/me/bookmarks').set(s.h).send({ kind: 'question', ...ref }).expect(201);
      await http().post('/v1/me/bookmarks').set(s.h).send({ kind: 'question', ...ref }).expect(201); // idempotent
      const list = (await http().get('/v1/me/bookmarks').set(s.h).expect(200)).body;
      expect(list.questions).toHaveLength(1);
      expect(list.questions[0]).toMatchObject({ questionId: t.questionIds[1], correctOption: 1 });
      expect(list.questions[0].en.explanation).toBeDefined();
      await http().delete(`/v1/me/bookmarks/question/${t.questionIds[1]}`).set(s.h).expect(204);
      expect((await http().get('/v1/me/bookmarks').set(s.h)).body.questions).toHaveLength(0);
    });

    it('hides the answer and explanation of a bookmarked question until its result is released', async () => {
      const s = await student();
      const t = await makeTest(prisma, { n: 4, resultReleaseAt: new Date(clock.now().getTime() + 3_600_000) });
      const id = await take(s, t, right);
      await http().post('/v1/me/bookmarks').set(s.h).send({ kind: 'question', attemptId: id, qid: t.tvqIds[0] }).expect(201);
      const q = (await http().get('/v1/me/bookmarks').set(s.h).expect(200)).body.questions[0];
      expect(q.correctOption).toBeNull();
      expect(q.en.explanation).toBeUndefined();
      clock.advance(2 * 3_600_000);
      expect((await http().get('/v1/me/bookmarks').set(s.h)).body.questions[0].correctOption).toBe(0);
    });

    it('bookmarks materials and current affairs that are published, and rejects others', async () => {
      const s = await student();
      const m = await prisma.material.create({ data: { titleEn: 'PDF', titleHi: 'पीडीएफ', kind: 'pdf', status: 'published', fileKey: 'k' } });
      const d = await prisma.material.create({ data: { titleEn: 'Draft', titleHi: 'ड्राफ्ट', kind: 'pdf', status: 'draft', fileKey: 'k' } });
      await http().post('/v1/me/bookmarks').set(s.h).send({ kind: 'material', refId: m.id }).expect(201);
      await http().post('/v1/me/bookmarks').set(s.h).send({ kind: 'material', refId: d.id }).expect(404);
      await http().post('/v1/me/bookmarks').set(s.h).send({ kind: 'bogus', refId: m.id }).expect(400);
      expect((await http().get('/v1/me/bookmarks?kind=material').set(s.h)).body.materials).toHaveLength(1);
    });

    it('saves one note per question (markup stripped) and reports a question once while it is open', async () => {
      const s = await student();
      const t = await makeTest(prisma, { n: 4 });
      const id = await take(s, t, right);
      const ref = { attemptId: id, qid: t.tvqIds[2] };
      await http().put('/v1/me/notes').set(s.h).send({ ...ref, text: 'first <script>alert(1)</script>' }).expect(200);
      const n = (await http().put('/v1/me/notes').set(s.h).send({ ...ref, text: 'second' }).expect(200)).body;
      expect(n.text).toBe('second');
      const notes = (await http().get('/v1/me/notes').set(s.h)).body;
      expect(notes).toHaveLength(1);
      expect(notes[0].question.questionId).toBe(t.questionIds[2]);
      await http().put('/v1/me/notes').set(s.h).send({ ...ref, text: '' }).expect(400);
      await http().delete(`/v1/me/notes/${t.questionIds[2]}`).set(s.h).expect(204);

      await http().post('/v1/me/question-reports').set(s.h).send({ ...ref, reason: 'typo', note: 'Spelling' }).expect(201);
      expect((await http().post('/v1/me/question-reports').set(s.h).send({ ...ref, reason: 'typo' }).expect(409)).body.error.code).toBe('ALREADY_REPORTED');
      expect((await prisma.question.findUniqueOrThrow({ where: { id: t.questionIds[2] } })).reportedCount).toBe(1);
      await http().post('/v1/me/question-reports').set(s.h).send({ ...ref, reason: 'rude' }).expect(400);
    });
  });

  describe('revision and practice sets', () => {
    it('lists wrong and bookmarked questions, newest first, optionally per topic', async () => {
      const s = await student();
      const t = await makeTest(prisma, { n: 6 });
      const id = await take(s, t, (i) => (i < 3 ? wrong(i) : right(i)));
      await http().post('/v1/me/bookmarks').set(s.h).send({ kind: 'question', attemptId: id, qid: t.tvqIds[5] }).expect(201);
      const r = (await http().get('/v1/me/revision').set(s.h).expect(200)).body;
      expect(r.total).toBe(4);
      expect(r.questions.filter((q: { reasons: string[] }) => q.reasons.includes('wrong'))).toHaveLength(3);
      expect(r.questions.find((q: { questionId: string }) => q.questionId === t.questionIds[5]).reasons).toEqual(['bookmarked']);
      const t1 = (await http().get('/v1/me/revision?topicCode=T1').set(s.h)).body;
      expect(t1.questions.every((q: { topicCode: string }) => q.topicCode === 'T1')).toBe(true);
      expect(t1.total).toBe(2); // wrong questions 0 and 2 are T1; question 1 is T2
    });

    it('builds a private practice test from a weak topic that the student can take, and nobody else can', async () => {
      const s = await student();
      const other = await student('other');
      const t = await makeTest(prisma, { n: 12 });
      await take(s, t, wrong);
      const p = (await http().post('/v1/practice').set(s.h).send({ source: 'topic', topicCode: 'T1', count: 5 }).expect(201)).body;
      expect(p.questions).toBe(5);
      const test = await prisma.test.findUniqueOrThrow({ where: { id: p.testId } });
      expect(test.ownerUserId).toBe(s.id);
      expect(test.titleEn).toBe('Practice: Topic T1');
      const a = await http().post(`/v1/tests/${p.testId}/attempts`).set(s.h).set('x-client-id', 'tab').send({}).expect(200);
      expect(a.body.questions ?? a.body.state).toBeDefined();
      await http().post(`/v1/tests/${p.testId}/attempts`).set(other.h).set('x-client-id', 'tab').send({}).expect(404);
      const catalog = (await http().get('/v1/tests').set(s.h).expect(200)).body;
      expect(JSON.stringify(catalog)).not.toContain(p.testId);
    });

    it('builds a revision set, refuses when there is nothing to revise, and limits sets per day', async () => {
      const s = await student();
      expect((await http().post('/v1/practice').set(s.h).send({ source: 'revision' }).expect(409)).body.error.code).toBe('NOT_ENOUGH_QUESTIONS');
      await take(s, await makeTest(prisma, { n: 8 }), wrong);
      const p = (await http().post('/v1/practice').set(s.h).send({ source: 'revision', count: 5 }).expect(201)).body;
      expect(p.questions).toBe(5);
      await http().post('/v1/practice').set(s.h).send({ source: 'topic', topicCode: 'NOPE' }).expect(400);
      await http().post('/v1/practice').set(s.h).send({ source: 'revision', count: 99 }).expect(400);
      for (let i = 0; i < 9; i++) await http().post('/v1/practice').set(s.h).send({ source: 'revision', count: 5 }).expect(201);
      expect((await http().post('/v1/practice').set(s.h).send({ source: 'revision', count: 5 }).expect(409)).body.error.code).toBe('PRACTICE_LIMIT');
    });
  });

  describe('overall leaderboard', () => {
    it('ranks by total score over the period, hides opted-out students from others but keeps their rank', async () => {
      const a = await student('a', 'Asha Verma');
      const b = await student('b', 'Bhanu Singh Rathore');
      const c = await student('c', 'Chitra Devi');
      const t = await makeTest(prisma, { n: 6 });
      await take(a, t, right);
      await take(b, t, (i) => (i < 3 ? right(i) : wrong(i)));
      await take(c, t, wrong);
      await http().patch('/v1/me').set(b.h).send({ showOnLeaderboard: false }).expect(200);
      const r = (await http().get('/v1/leaderboard?period=week').set(a.h).expect(200)).body;
      expect(r.total).toBe(3);
      expect(r.entries.map((e: { name: string; rank: number }) => [e.name, e.rank])).toEqual([['Asha V.', 1], ['Chitra D.', 3]]);
      expect(r.me).toMatchObject({ rank: 1, isMe: true });
      const mine = (await http().get('/v1/leaderboard').set(b.h)).body;
      expect(mine.me.rank).toBe(2);
      expect(mine.entries.map((e: { isMe: boolean }) => e.isMe)).toEqual([false, true, false]);
      clock.advance(10 * 86_400_000);
      expect((await http().get('/v1/leaderboard?period=week').set(a.h)).body.entries).toHaveLength(0);
      expect((await http().get('/v1/leaderboard?period=all').set(a.h)).body.total).toBe(3);
      await http().get('/v1/leaderboard?period=year').set(a.h).expect(400);
    });

    it('leaves out personal practice sets and unreleased results', async () => {
      const a = await student('a');
      await take(a, await makeTest(prisma, { n: 4, ownerUserId: a.id }), right);
      await take(a, await makeTest(prisma, { n: 4, resultReleaseAt: new Date(clock.now().getTime() + 3_600_000) }), right);
      expect((await http().get('/v1/leaderboard').set(a.h)).body).toMatchObject({ total: 0, entries: [], me: null });
    });
  });

  describe('purchases', () => {
    it('lists the student\'s own orders with invoice numbers and returns receipts only for invoiced orders', async () => {
      const s = await student();
      const other = await student('other');
      await prisma.plan.create({ data: { id: 'pass', nameEn: 'Pass', nameHi: 'पास', prices: { '3': 100 } } });
      const paid = await prisma.order.create({ data: { userId: s.id, planId: 'pass', months: 3, amountPaise: 10000, status: 'paid', razorpayOrderId: 'order_1', payments: { create: { razorpayPaymentId: 'pay_1', amountPaise: 10000, status: 'captured', method: 'upi' } } } });
      await prisma.invoice.create({ data: { orderId: paid.id, number: 'EG-2026-000001' } });
      const pending = await prisma.order.create({ data: { userId: s.id, planId: 'pass', months: 3, amountPaise: 10000, razorpayOrderId: 'order_2' } });
      await prisma.order.create({ data: { userId: other.id, planId: 'pass', months: 3, amountPaise: 10000, razorpayOrderId: 'order_3' } });
      const list = (await http().get('/v1/me/orders').set(s.h).expect(200)).body;
      expect(list).toHaveLength(2);
      expect(list.find((o: { id: string }) => o.id === paid.id)).toMatchObject({ invoiceNumber: 'EG-2026-000001', paymentStatus: 'captured', planNameEn: 'Pass' });
      const rc = (await http().get(`/v1/me/orders/${paid.id}/receipt`).set(s.h).expect(200)).body;
      expect(rc).toMatchObject({ number: 'EG-2026-000001', amountPaise: 10000, paymentId: 'pay_1', method: 'upi', plan: { id: 'pass' } });
      await http().get(`/v1/me/orders/${pending.id}/receipt`).set(s.h).expect(404);
      await http().get(`/v1/me/orders/${paid.id}/receipt`).set(other.h).expect(404);
    });
  });
});

describe('student: account data', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clock: FakeClock;
  beforeAll(async () => ({ app, prisma, clock } = await createApp()));
  afterAll(() => app.close());
  beforeEach(async () => {
    clock.reset();
    await resetDb(prisma);
    await baseTaxonomy(prisma);
  });
  const http = () => request(app.getHttpServer());

  it('lists exams with their papers and marking rules', async () => {
    const r = (await http().get('/v1/exams').expect(200)).body;
    expect(r[0].id).toBe('cgpsc');
    expect(r[0].papers[0]).toMatchObject({ code: 'PRE_GS', questionCount: 10, durationMin: 10 });
  });

  it('exports everything the student owns, and nothing secret or foreign', async () => {
    const l = await login(app, 'stu', 'device-stu-1', 'android', 'Asha Verma');
    const h = bearer(l.body.accessToken);
    const other = await login(app, 'oth', 'device-oth-1', 'android', 'Other Person');
    const t = await makeTest(prisma, { n: 4 });
    const a = (await http().post(`/v1/tests/${t.testId}/attempts`).set(h).set('x-client-id', 'tab').send({}).expect(200)).body;
    await http().put(`/v1/attempts/${a.attemptId}/state`).set(h).set('x-client-id', 'tab').send({ seq: 1, answers: [{ qid: t.tvqIds[0], selected: 0, visited: true, seq: 1 }] }).expect(200);
    await http().post(`/v1/attempts/${a.attemptId}/submit`).set(h).send({ submitKey: 'k' }).expect(200);
    await http().post('/v1/doubts').set(h).send({ text: 'A question for the teacher' }).expect(201);
    const doc = (await http().get('/v1/me/export').set(h).expect(200)).body;
    expect(doc.profile).toMatchObject({ name: 'Asha Verma', email: expect.any(String) });
    expect(doc.attempts[0].answers[0]).toMatchObject({ selected: 0 });
    expect(doc.results).toHaveLength(1);
    expect(doc.doubts[0].messages[0].text).toBe('A question for the teacher');
    const text = JSON.stringify(doc);
    expect(text).not.toContain('googleSub');
    expect(text).not.toContain('Other Person');
    expect(text).not.toContain(other.body.user.id);
    await http().get('/v1/me/export').expect(401);
  });

  it('deleting the account needs explicit confirmation, erases personal data, ends the session and keeps orders', async () => {
    const l = await login(app, 'stu', 'device-stu-1', 'android', 'Asha Verma');
    const h = bearer(l.body.accessToken);
    const id = l.body.user.id as string;
    await prisma.plan.create({ data: { id: 'pass', nameEn: 'Pass', nameHi: 'पास', prices: { '3': 1 } } });
    await prisma.order.create({ data: { userId: id, planId: 'pass', months: 3, amountPaise: 100, status: 'paid', razorpayOrderId: 'order_x' } });
    await prisma.userNote.create({ data: { userId: id, questionId: (await makeQuestions(prisma, 1, 'D'))[0], text: 'private' } });
    await http().post('/v1/doubts').set(h).send({ text: 'Please help me here' }).expect(201);
    await http().delete('/v1/me').set(h).send({}).expect(400);
    await http().delete('/v1/me').set(h).send({ confirm: 'yes' }).expect(400);
    await http().delete('/v1/me').set(h).send({ confirm: 'DELETE' }).expect(204);
    await http().get('/v1/me').set(h).expect(401); // the session is gone
    const u = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(u).toMatchObject({ name: 'Deleted user', avatarUrl: null, phone: null, showOnLeaderboard: false });
    expect(u.email).toContain('deleted.invalid');
    expect(u.deletedAt).not.toBeNull();
    expect(await prisma.userNote.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.doubt.count({ where: { userId: id } })).toBe(0);
    expect(await prisma.order.count({ where: { userId: id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'account.delete', target: id } })).toBe(1);
    // the same Google account can start again as a brand-new student
    const again = await login(app, 'stu', 'device-stu-1', 'android', 'Asha Verma');
    expect(again.body.user.id).not.toBe(id);
  });
});
