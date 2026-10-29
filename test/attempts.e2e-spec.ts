import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createDraftFromLatest, publishTestVersion } from '../src/modules/tests/test-publishing';
import { answerKey, baseTaxonomy, makeTest } from './fixtures';
import { bearer, createApp, FakeClock, login, resetDb } from './helpers';
import { AttemptFinalizer } from '../src/modules/attempts/attempt-finalizer';
import { SettingsService } from '../src/modules/settings/settings.service';

describe('test engine', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clock: FakeClock;
  let finalizer: AttemptFinalizer;
  beforeAll(async () => ({ app, prisma, clock, finalizer } = await createApp()));
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    clock.reset();
    app.get(SettingsService).clearCache();
    await resetDb(prisma);
    await baseTaxonomy(prisma);
  });

  async function student(sub: string, name?: string) {
    const r = await login(app, sub, `device-${sub}-1`, 'android', name);
    return { h: bearer(r.body.accessToken), id: r.body.user.id as string };
  }
  const start = (h: Record<string, string>, testId: string, body: object = {}, client = 'tab-1') =>
    http().post(`/v1/tests/${testId}/attempts`).set(h).set('x-client-id', client).send(body);
  const save = (h: Record<string, string>, attemptId: string, body: object, client = 'tab-1') =>
    http().put(`/v1/attempts/${attemptId}/state`).set(h).set('x-client-id', client).send(body);
  const submit = (h: Record<string, string>, attemptId: string, body: object = { submitKey: 'k1' }) =>
    http().post(`/v1/attempts/${attemptId}/submit`).set(h).send(body);

  describe('catalog', () => {
    it('lists published tests with lock flags, filters and pagination, and shows detail', async () => {
      const free = await makeTest(prisma, { title: 'Free one' });
      await makeTest(prisma, { title: 'Paid one', access: 'paid' });
      const s = await student('a');
      const list = await http().get('/v1/tests?pageSize=1').set(s.h).expect(200);
      expect(list.body).toMatchObject({ total: 2, page: 1, pageSize: 1 });
      expect(list.body.items).toHaveLength(1);
      const all = await http().get('/v1/tests').set(s.h).expect(200);
      const paid = all.body.items.find((t: { titleEn: string }) => t.titleEn === 'Paid one');
      expect(paid.locked).toBe(true);
      expect((await http().get('/v1/tests?access=free').set(s.h).expect(200)).body.items).toHaveLength(1);
      expect((await http().get('/v1/tests?pageSize=500').set(s.h)).status).toBe(400);
      const d = await http().get(`/v1/tests/${free.testId}`).set(s.h).expect(200);
      expect(d.body).toMatchObject({ questionCount: 6, maxScore: 12, scheme: { correctMarks: 2, negativeFraction: 1 / 3 } });
      expect(JSON.stringify(d.body)).not.toContain('explanation');
    });

    it('hides unpublished and archived tests', async () => {
      const t = await makeTest(prisma);
      const s = await student('a');
      await prisma.test.update({ where: { id: t.testId }, data: { archived: true } });
      expect((await http().get('/v1/tests').set(s.h)).body.items).toHaveLength(0);
      await start(s.h, t.testId).expect(404);
    });
  });

  describe('start, resume, answer-key protection', () => {
    it('reopens a running attempt by id (refresh / resume link) with saved state, and refuses finished or foreign attempts', async () => {
      const t = await makeTest(prisma);
      const s = await student('a');
      const other = await student('b');
      const a = (await start(s.h, t.testId).expect(200)).body;
      await save(s.h, a.attemptId, { seq: 1, currentIndex: 2, answers: [{ qid: a.questions[0].qid, selected: 1, visited: true, seq: 1 }] }).expect(200);
      const again = (await http().get(`/v1/attempts/${a.attemptId}`).set(s.h).set('x-client-id', 'tab-1').expect(200)).body;
      expect(again.attemptId).toBe(a.attemptId);
      expect(again.state.currentIndex).toBe(2);
      expect(again.state.answers[0]).toMatchObject({ selected: 1 });
      expect(JSON.stringify(again)).not.toContain('explanation');
      await http().get(`/v1/attempts/${a.attemptId}`).set(other.h).expect(404);
      await submit(s.h, a.attemptId).expect(200);
      expect((await http().get(`/v1/attempts/${a.attemptId}`).set(s.h).expect(409)).body.error.code).toBe('ATTEMPT_CLOSED');
      await http().get('/v1/attempts/not-a-uuid').set(s.h).expect(400);
    });

    it('serves frozen questions without answers or explanations and resumes the same attempt', async () => {
      const t = await makeTest(prisma);
      const s = await student('a');
      const a = await start(s.h, t.testId).expect(200);
      expect(a.body.questions).toHaveLength(6);
      const raw = JSON.stringify(a.body);
      expect(raw).not.toContain('explanation');
      expect(raw).not.toContain('"answer"');
      expect(raw).not.toContain('correctOption');
      expect(a.body.questions[0]).toMatchObject({ position: 1, sectionPos: 0, marks: 2, type: 'single' });
      expect(a.body.remainingSec).toBeGreaterThan(590);
      expect(a.body.isRanked).toBe(true);
      const again = await start(s.h, t.testId).expect(200);
      expect(again.body.attemptId).toBe(a.body.attemptId);
    });

    it('requires a paid plan for paid tests', async () => {
      const t = await makeTest(prisma, { access: 'paid' });
      const s = await student('a');
      expect((await start(s.h, t.testId).expect(403)).body.error.code).toBe('PAYMENT_REQUIRED');
      await prisma.plan.create({ data: { id: 'p', nameEn: 'p', nameHi: 'p', prices: { '3': 1 } } });
      await prisma.entitlement.create({ data: { userId: s.id, planId: 'p', endsAt: new Date(Date.now() + 864e5), source: 'admin' } });
      await start(s.h, t.testId).expect(200);
    });

    it('requires authentication and a valid test id', async () => {
      await http().post('/v1/tests/00000000-0000-4000-8000-000000000000/attempts').expect(401);
      const s = await student('a');
      await http().post('/v1/tests/not-a-uuid/attempts').set(s.h).expect(400);
      await start(s.h, '00000000-0000-4000-8000-000000000000').expect(404);
    });
  });

  describe('autosave and resume', () => {
    it('persists answers, marks, visited, current question and language, and restores them', async () => {
      const t = await makeTest(prisma);
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      const [q0, q1] = a.questions;
      const r = await save(s.h, a.attemptId, { seq: 1, currentIndex: 1, language: 'en', answers: [{ qid: q0.qid, selected: 2, visited: true, marked: false, timeSpentSec: 12, seq: 1 }, { qid: q1.qid, visited: true, marked: true, seq: 1 }] }).expect(200);
      expect(r.body.saved).toBe(2);
      expect(r.body.rejected).toEqual([]);
      const back = (await start(s.h, t.testId)).body;
      expect(back.state).toMatchObject({ currentIndex: 1, language: 'en', seq: 1 });
      const byQid = Object.fromEntries(back.state.answers.map((x: { qid: string }) => [x.qid, x]));
      expect(byQid[q0.qid]).toMatchObject({ selected: 2, visited: true, marked: false, timeSpentSec: 12 });
      expect(byQid[q1.qid]).toMatchObject({ selected: null, marked: true });
    });

    it('ignores stale offline-queue writes (lower sequence) but accepts newer ones', async () => {
      const t = await makeTest(prisma);
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      const q = a.questions[0].qid;
      await save(s.h, a.attemptId, { seq: 5, answers: [{ qid: q, selected: 1, seq: 5 }] }).expect(200);
      await save(s.h, a.attemptId, { seq: 3, currentIndex: 4, answers: [{ qid: q, selected: 3, seq: 3 }] }).expect(200);
      let st = (await start(s.h, t.testId)).body.state;
      expect(st.answers.find((x: { qid: string }) => x.qid === q).selected).toBe(1);
      expect(st.currentIndex).toBe(0); // stale navigation ignored too
      await save(s.h, a.attemptId, { seq: 6, answers: [{ qid: q, selected: null, seq: 6 }] }).expect(200);
      st = (await start(s.h, t.testId)).body.state;
      expect(st.answers.find((x: { qid: string }) => x.qid === q).selected).toBeNull();
    });

    it('validates the payload', async () => {
      const t = await makeTest(prisma);
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      await save(s.h, a.attemptId, { seq: 1, answers: [{ qid: a.questions[0].qid, selected: 9, seq: 1 }] }).expect(400);
      const unknown = await save(s.h, a.attemptId, { seq: 1, answers: [{ qid: '00000000-0000-4000-8000-000000000000', selected: 1, seq: 1 }] }).expect(400);
      expect(unknown.body.error.code).toBe('UNKNOWN_QUESTION');
      await save(s.h, a.attemptId, { answers: [] }).expect(400);
    });
  });

  describe('submit, scoring and idempotency', () => {
    async function answered() {
      const t = await makeTest(prisma);
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      const key = await answerKey(prisma, t.versionId);
      const [q0, q1, q2, q3] = a.questions.map((q: { qid: string }) => q.qid);
      // q0 correct, q1 wrong, q2 correct, q3 skipped (q4,q5 untouched)
      const wrong = ((key.get(q1) as number) + 1) % 4;
      await save(s.h, a.attemptId, { seq: 1, answers: [{ qid: q0, selected: key.get(q0), seq: 1, timeSpentSec: 10 }, { qid: q1, selected: wrong, seq: 1, timeSpentSec: 20 }, { qid: q2, selected: key.get(q2), seq: 1, timeSpentSec: 5 }, { qid: q3, selected: null, seq: 1 }] }).expect(200);
      return { t, s, a };
    }

    it('scores on the server with negative marking and returns the breakdown', async () => {
      const { s, a } = await answered();
      const r = await submit(s.h, a.attemptId).expect(200);
      expect(r.body).toMatchObject({ released: true, status: 'submitted', correct: 2, wrong: 1, skipped: 3, attempted: 3, maxScore: 12, isRanked: true, rank: 1, percentile: 100 });
      expect(r.body.score).toBe(3.33); // 2*2 - 2/3
      expect(r.body.negativeDeducted).toBe(0.67);
      expect(r.body.accuracyPct).toBe(66.67);
      expect(r.body.sections).toHaveLength(1);
      expect(r.body.topics.length).toBeGreaterThan(0);
      expect(r.body.comparison).toMatchObject({ topperScore: 3.33, averageScore: 3.33 });
      expect(r.body.questionTimes).toHaveLength(6);
    });

    it('is idempotent: same key, different key and concurrent submits give one result row', async () => {
      const { s, a } = await answered();
      const results = await Promise.all([1, 2, 3, 4, 5].map((i) => submit(s.h, a.attemptId, { submitKey: `k${i}` })));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.score)).size).toBe(1);
      expect(await prisma.attemptResult.count()).toBe(1);
      const again = await submit(s.h, a.attemptId, { submitKey: 'k1' }).expect(200);
      expect(again.body.score).toBe(3.33);
      expect(await prisma.userTopicStat.aggregate({ _sum: { attempted: true } }).then((x) => x._sum.attempted)).toBe(3); // stats counted once
    });

    it('refuses saves after submit', async () => {
      const { s, a } = await answered();
      await submit(s.h, a.attemptId).expect(200);
      const late = await save(s.h, a.attemptId, { seq: 9, answers: [] }).expect(409);
      expect(late.body.error.code).toBe('ATTEMPT_CLOSED');
    });

    it('applies final unsaved answers sent with the submit while time remains', async () => {
      const t = await makeTest(prisma);
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      const key = await answerKey(prisma, t.versionId);
      const q = a.questions[0].qid;
      const r = await submit(s.h, a.attemptId, { submitKey: 'final', answers: [{ qid: q, selected: key.get(q), seq: 1 }] }).expect(200);
      expect(r.body).toMatchObject({ correct: 1, score: 2 });
    });

    it('stores one ranked result per student; a second attempt is practice and unranked', async () => {
      const t = await makeTest(prisma);
      const s = await student('a');
      const a1 = (await start(s.h, t.testId)).body;
      await submit(s.h, a1.attemptId).expect(200);
      const a2 = (await start(s.h, t.testId)).body;
      expect(a2.isPractice).toBe(true);
      expect(a2.isRanked).toBe(false);
      const r2 = await submit(s.h, a2.attemptId, { submitKey: 'p' }).expect(200);
      expect(r2.body.rank).toBeNull();
      expect(await prisma.attempt.count({ where: { isRanked: true } })).toBe(1);
    });

    it('enforces the attempt limit', async () => {
      const t = await makeTest(prisma, { attemptLimit: 2 });
      const s = await student('a');
      for (let i = 0; i < 2; i++) {
        const a = (await start(s.h, t.testId)).body;
        await submit(s.h, a.attemptId, { submitKey: `k${i}` }).expect(200);
      }
      expect((await start(s.h, t.testId).expect(409)).body.error.code).toBe('ATTEMPT_LIMIT');
    });
  });

  describe('server-authoritative timer', () => {
    it('auto-submits with the sweeper when the client never comes back', async () => {
      const t = await makeTest(prisma, { durationMin: 5 });
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      const key = await answerKey(prisma, t.versionId);
      const q = a.questions[0].qid;
      await save(s.h, a.attemptId, { seq: 1, answers: [{ qid: q, selected: key.get(q), seq: 1 }] }).expect(200);
      clock.advance(5 * 60_000 + 5_000);
      expect(await finalizer.sweepOnce()).toBe(0); // still inside the grace period
      clock.advance(20_000);
      expect(await finalizer.sweepOnce()).toBe(1);
      const row = await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } });
      expect(row).toMatchObject({ status: 'expired', finalizedBy: 'auto_timer' });
      const r = await http().get(`/v1/attempts/${a.attemptId}/result`).set(s.h).expect(200);
      expect(r.body).toMatchObject({ correct: 1, score: 2, status: 'expired' });
      expect(r.body.timeSpentSec).toBeLessThanOrEqual(300);
      expect(await finalizer.sweepOnce()).toBe(0);
    });

    it('rejects a late save and finalizes on the spot (no sweeper needed)', async () => {
      const t = await makeTest(prisma, { durationMin: 5 });
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      clock.advance(5 * 60_000 + 60_000);
      const late = await save(s.h, a.attemptId, { seq: 2, answers: [{ qid: a.questions[0].qid, selected: 1, seq: 2 }] }).expect(409);
      expect(late.body.error.code).toBe('ATTEMPT_EXPIRED');
      expect((await prisma.attempt.findUniqueOrThrow({ where: { id: a.attemptId } })).status).toBe('expired');
      expect((await prisma.attemptAnswer.count({ where: { attemptId: a.attemptId } }))).toBe(0);
    });

    it('a submit that arrives after the deadline counts only what was already saved', async () => {
      const t = await makeTest(prisma, { durationMin: 5 });
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      const key = await answerKey(prisma, t.versionId);
      clock.advance(10 * 60_000);
      const r = await submit(s.h, a.attemptId, { submitKey: 'late', answers: [{ qid: a.questions[0].qid, selected: key.get(a.questions[0].qid), seq: 1 }] }).expect(200);
      expect(r.body).toMatchObject({ correct: 0, skipped: 6, finalizedBy: 'auto_timer' });
    });

    it('lets a student whose attempt expired while away start a fresh one', async () => {
      const t = await makeTest(prisma, { durationMin: 5, attemptLimit: 3 });
      const s = await student('a');
      const a1 = (await start(s.h, t.testId)).body;
      clock.advance(10 * 60_000);
      const a2 = (await start(s.h, t.testId)).body;
      expect(a2.attemptId).not.toBe(a1.attemptId);
      expect((await prisma.attempt.findUniqueOrThrow({ where: { id: a1.attemptId } })).status).toBe('expired');
    });
  });

  describe('result release and answer-key protection', () => {
    it('keeps score and solutions hidden until the release time', async () => {
      const release = new Date(Date.now() + 3_600_000);
      const t = await makeTest(prisma, { resultReleaseAt: release });
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      const r = await submit(s.h, a.attemptId).expect(200);
      expect(r.body.released).toBe(false);
      expect(r.body.score).toBeUndefined();
      expect(r.body.resultReleaseAt).toBeTruthy();
      expect((await http().get(`/v1/attempts/${a.attemptId}/review`).set(s.h).expect(409)).body.error.code).toBe('RESULT_NOT_RELEASED');
      expect((await http().get(`/v1/tests/${t.testId}/leaderboard`).set(s.h).expect(200)).body.released).toBe(false);
      clock.advance(3_700_000);
      const after = await http().get(`/v1/attempts/${a.attemptId}/result`).set(s.h).expect(200);
      expect(after.body.released).toBe(true);
      const review = await http().get(`/v1/attempts/${a.attemptId}/review`).set(s.h).expect(200);
      expect(review.body.questions[0].en.explanation).toContain('explanation');
      expect(review.body.questions[0].hi.explanation).toContain('व्याख्या');
      expect(review.body.questions[0]).toHaveProperty('correctOption');
      expect(review.body.questions[0].questionId).toBe(t.questionIds[0]);
    });

    it('never exposes the key while the attempt is running', async () => {
      const t = await makeTest(prisma);
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      expect((await http().get(`/v1/attempts/${a.attemptId}/result`).set(s.h).expect(409)).body.error.code).toBe('NOT_SUBMITTED');
      expect((await http().get(`/v1/attempts/${a.attemptId}/review`).set(s.h).expect(409)).body.error.code).toBe('NOT_SUBMITTED');
    });
  });

  describe('rank, percentile, leaderboard', () => {
    it('ranks first attempts, computes percentile, topper and average, and honours the privacy opt-out', async () => {
      const t = await makeTest(prisma);
      const key = await answerKey(prisma, t.versionId);
      const players = [
        { sub: 'top', correct: 5, name: 'Top Player' },
        { sub: 'mid', correct: 3, name: 'Mid Player' },
        { sub: 'low', correct: 1, name: 'Low Player' },
      ];
      const handles: Record<string, { h: Record<string, string>; id: string; attempt: string }> = {};
      for (const p of players) {
        const s = await student(p.sub, p.name);
        const a = (await start(s.h, t.testId)).body;
        const qs = a.questions.slice(0, p.correct).map((q: { qid: string }) => ({ qid: q.qid, selected: key.get(q.qid), seq: 1 }));
        await save(s.h, a.attemptId, { seq: 1, answers: qs }).expect(200);
        await submit(s.h, a.attemptId).expect(200);
        handles[p.sub] = { ...s, attempt: a.attemptId };
      }
      const mid = (await http().get(`/v1/attempts/${handles.mid.attempt}/result`).set(handles.mid.h).expect(200)).body;
      expect(mid).toMatchObject({ rank: 2, rankedAttempters: 3, percentile: 50, score: 6 });
      expect(mid.comparison).toMatchObject({ topperScore: 10, averageScore: 6 });
      const top = (await http().get(`/v1/attempts/${handles.top.attempt}/result`).set(handles.top.h).expect(200)).body;
      expect(top).toMatchObject({ rank: 1, percentile: 100 });
      const low = (await http().get(`/v1/attempts/${handles.low.attempt}/result`).set(handles.low.h).expect(200)).body;
      expect(low).toMatchObject({ rank: 3, percentile: 0 });

      await prisma.user.update({ where: { id: handles.top.id }, data: { showOnLeaderboard: false } });
      const lb = (await http().get(`/v1/tests/${t.testId}/leaderboard`).set(handles.mid.h).expect(200)).body;
      expect(lb.total).toBe(3);
      expect(lb.entries.map((e: { rank: number }) => e.rank)).toEqual([2, 3]); // top is hidden but keeps rank 1
      expect(lb.entries[0]).toMatchObject({ name: 'Mid P.', isMe: true });
      expect(lb.me).toMatchObject({ rank: 2, percentile: 50 });
    });
  });

  describe('multi-tab policy', () => {
    it('takeover (default): the newest tab owns the attempt, the old one is told so', async () => {
      const t = await makeTest(prisma);
      const s = await student('a');
      const a = (await start(s.h, t.testId, {}, 'tab-1')).body;
      await start(s.h, t.testId, {}, 'tab-2').expect(200);
      const old = await save(s.h, a.attemptId, { seq: 1, answers: [] }, 'tab-1').expect(409);
      expect(old.body.error.code).toBe('ATTEMPT_TAKEN_OVER');
      await save(s.h, a.attemptId, { seq: 1, answers: [] }, 'tab-2').expect(200);
    });

    it('block: a second live tab is refused until the first goes quiet', async () => {
      const t = await makeTest(prisma);
      await app.get(SettingsService).set('attempt.multiClientPolicy', 'block');
      const s = await student('a');
      await start(s.h, t.testId, {}, 'tab-1').expect(200);
      expect((await start(s.h, t.testId, {}, 'tab-2').expect(409)).body.error.code).toBe('ATTEMPT_IN_USE');
      clock.advance(60_000); // tab-1 stopped sending heartbeats (the lock is stale after 45 s)
      await start(s.h, t.testId, {}, 'tab-2').expect(200);
    });
  });

  describe('sections and sectional timers', () => {
    it('plain sections group questions without separate timers', async () => {
      const t = await makeTest(prisma, { n: 6, sections: [{ count: 3 }, { count: 3 }] });
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      expect(a.sections.map((x: { count: number }) => x.count)).toEqual([3, 3]);
      expect(a.questions.map((q: { sectionPos: number }) => q.sectionPos)).toEqual([0, 0, 0, 1, 1, 1]);
      const r = await submit(s.h, a.attemptId).expect(200);
      expect(r.body.sections).toHaveLength(2);
    });

    it('sectional timers: later sections are closed until reached, earlier ones lock when time or advance ends them', async () => {
      const t = await makeTest(prisma, { n: 4, sections: [{ count: 2, durationMin: 2 }, { count: 2, durationMin: 2 }], sectionalTimers: true });
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      expect(a.scheme.sectionalTimers).toBe(true);
      expect(a.openSection).toBe(0);
      const [q0, , q2] = a.questions.map((q: { qid: string }) => q.qid);
      const notYet = await save(s.h, a.attemptId, { seq: 1, answers: [{ qid: q2, selected: 1, seq: 1 }, { qid: q0, selected: 1, seq: 1 }] }).expect(200);
      expect(notYet.body.rejected).toEqual([{ qid: q2, reason: 'SECTION_NOT_STARTED' }]);
      expect(notYet.body.saved).toBe(1);

      await http().post(`/v1/attempts/${a.attemptId}/sections/advance`).set(s.h).set('x-client-id', 'tab-1').expect(200);
      const closed = await save(s.h, a.attemptId, { seq: 2, answers: [{ qid: q0, selected: 2, seq: 2 }, { qid: q2, selected: 1, seq: 2 }] }).expect(200);
      expect(closed.body.rejected).toEqual([{ qid: q0, reason: 'SECTION_CLOSED' }]);
      expect(closed.body.openSection).toBe(1);
      expect((await http().post(`/v1/attempts/${a.attemptId}/sections/advance`).set(s.h).set('x-client-id', 'tab-1').expect(409)).body.error.code).toBe('LAST_SECTION');
    });

    it('sectional timers: time alone moves the server to the next section', async () => {
      const t = await makeTest(prisma, { n: 4, sections: [{ count: 2, durationMin: 2 }, { count: 2, durationMin: 2 }], sectionalTimers: true });
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      clock.advance(2 * 60_000 + 1_000);
      const r = await save(s.h, a.attemptId, { seq: 1, answers: [{ qid: a.questions[0].qid, selected: 1, seq: 1 }, { qid: a.questions[2].qid, selected: 1, seq: 1 }] }).expect(200);
      expect(r.body.openSection).toBe(1);
      expect(r.body.rejected).toEqual([{ qid: a.questions[0].qid, reason: 'SECTION_CLOSED' }]);
      expect(r.body.saved).toBe(1);
    });
  });

  describe('qualifying papers', () => {
    it('reports whether the general and reserved cut-offs were met', async () => {
      const t = await makeTest(prisma, { n: 10, qualifyingPct: 33, qualifyingPctReserved: 23 });
      const key = await answerKey(prisma, t.versionId);
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      // 3 of 10 correct = 30%: below 33 (general) but above 23 (reserved)
      const answers = a.questions.slice(0, 3).map((q: { qid: string }) => ({ qid: q.qid, selected: key.get(q.qid), seq: 1 }));
      await save(s.h, a.attemptId, { seq: 1, answers }).expect(200);
      const r = (await submit(s.h, a.attemptId).expect(200)).body;
      expect(r.qualifying).toEqual({ requiredPct: 33, requiredPctReserved: 23, general: false, reserved: true, countsTowardMerit: false });
    });
  });

  describe('live tests', () => {
    it('opens at the start time, finishes everyone together, ranks one attempt, then allows practice only', async () => {
      const startsAt = new Date(Date.now() + 10 * 60_000);
      const endsAt = new Date(Date.now() + 20 * 60_000);
      const t = await makeTest(prisma, { mode: 'live', kind: 'live', startsAt, endsAt, durationMin: 30 });
      const s = await student('a');
      expect((await start(s.h, t.testId).expect(409)).body.error.code).toBe('NOT_OPEN');
      clock.advance(12 * 60_000);
      const a = (await start(s.h, t.testId)).body;
      expect(new Date(a.deadlineAt).getTime()).toBe(startsAt.getTime() + 30 * 60_000);
      expect(a.isRanked).toBe(true);
      await submit(s.h, a.attemptId).expect(200);
      expect((await start(s.h, t.testId).expect(409)).body.error.code).toBe('ATTEMPT_LIMIT'); // one attempt while the window is open
      clock.advance(60 * 60_000);
      const practice = (await start(s.h, t.testId)).body;
      expect(practice.isPractice).toBe(true);
    });

    it('a student who first arrives after the window can only practise', async () => {
      const t = await makeTest(prisma, { mode: 'live', kind: 'live', startsAt: new Date(Date.now() + 1_000), endsAt: new Date(Date.now() + 60_000), durationMin: 10 });
      const s = await student('late');
      clock.advance(5 * 60_000);
      const a = (await start(s.h, t.testId)).body;
      expect(a).toMatchObject({ isPractice: true, isRanked: false });
    });
  });

  describe('test versions protect existing attempts', () => {
    it('a running attempt keeps its frozen questions and answer key after the test is edited and re-published', async () => {
      const t = await makeTest(prisma, { n: 4 });
      const s = await student('a');
      const a = (await start(s.h, t.testId)).body;
      const qid = a.questions[0].qid;
      const keyV1 = await answerKey(prisma, t.versionId);
      // The admin corrects question 0's answer key and publishes version 2.
      const tvq = await prisma.testVersionQuestion.findUniqueOrThrow({ where: { id: qid } });
      await prisma.question.update({ where: { id: tvq.questionId }, data: { answer: 3, version: { increment: 1 } } });
      await prisma.$transaction(async (tx) => {
        const draft = await createDraftFromLatest(tx, t.testId);
        expect(draft.version).toBe(2);
        await publishTestVersion(tx, draft.id);
      });
      // Students starting now get version 2; the running attempt is still on version 1.
      await save(s.h, a.attemptId, { seq: 1, answers: [{ qid, selected: keyV1.get(qid), seq: 1 }] }).expect(200);
      const r = (await submit(s.h, a.attemptId).expect(200)).body;
      expect(r).toMatchObject({ correct: 1, score: 2 });
      const other = await student('b');
      const b = (await start(other.h, t.testId)).body;
      expect(b.versionId).not.toBe(t.versionId);
      const keyV2 = await answerKey(prisma, b.versionId);
      const tvq2 = b.questions.find((x: { qid: string }) => keyV2.get(x.qid) === 3);
      expect(tvq2).toBeTruthy();
    });

    it('the database refuses to change a published version or its questions', async () => {
      const t = await makeTest(prisma);
      await expect(prisma.testVersion.update({ where: { id: t.versionId }, data: { correctMarks: 99 } })).rejects.toThrow(/published/);
      await expect(prisma.testVersionQuestion.update({ where: { id: t.tvqIds[0] }, data: { marks: 50 } })).rejects.toThrow(/frozen/);
      await expect(prisma.testVersionQuestion.delete({ where: { id: t.tvqIds[0] } })).rejects.toThrow(/frozen/);
    });

    it('publishing is blocked for unpublished questions, empty tests and bad sections', async () => {
      await prisma.$transaction(async (tx) => {
        const test = await tx.test.create({ data: { examId: 'cgpsc', titleEn: 'x', titleHi: 'x', kind: 'mock' } });
        const v = await tx.testVersion.create({ data: { testId: test.id, version: 1, durationMin: 10, correctMarks: 2, negativeFraction: 0.33 } });
        await expect(publishTestVersion(tx, v.id)).rejects.toMatchObject({ code: 'PUBLISH_BLOCKED' });
      }).catch((e) => expect(e.code).toBe('PUBLISH_BLOCKED'));
      const draftQ = await prisma.question.create({ data: { code: 'DRAFTQ', topicCode: 'T1', answer: 0, status: 'draft', body: { en: { stem: 's', options: ['a', 'b', 'c', 'd'] } }, hasEn: true, contentHash: 'h' } });
      await prisma.$transaction(async (tx) => {
        const test = await tx.test.create({ data: { examId: 'cgpsc', titleEn: 'x', titleHi: 'x', kind: 'mock' } });
        const v = await tx.testVersion.create({ data: { testId: test.id, version: 1, durationMin: 10, correctMarks: 2, negativeFraction: 0.33 } });
        await tx.testVersionQuestion.create({ data: { versionId: v.id, position: 0, questionId: draftQ.id, questionVersion: 1 } });
        await publishTestVersion(tx, v.id);
      }).then(
        () => { throw new Error('should have been blocked'); },
        (e) => expect(e.details[0].message).toContain('publish it first'),
      );
    });
  });

  describe('access control', () => {
    it("a student cannot read, save or submit another student's attempt (404)", async () => {
      const t = await makeTest(prisma);
      const alice = await student('alice');
      const bob = await student('bob');
      const a = (await start(alice.h, t.testId)).body;
      await save(bob.h, a.attemptId, { seq: 1, answers: [] }).expect(404);
      await submit(bob.h, a.attemptId).expect(404);
      await http().get(`/v1/attempts/${a.attemptId}/result`).set(bob.h).expect(404);
      await http().get(`/v1/attempts/${a.attemptId}/review`).set(bob.h).expect(404);
      await http().get(`/v1/attempts/${a.attemptId}/result`).expect(401);
    });
  });
});
