import { INestApplication } from '@nestjs/common';
import { AccessLevel } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createApp, login, resetDb } from './helpers';

const Q = (id: string, answer: number) => ({
  id,
  topicCode: 'T1',
  answer,
  published: true,
  body: {
    en: { q: `Q ${id}`, o: ['a', 'b', 'c', 'd'], s: `explanation ${id}` },
    hi: { q: `प्र ${id}`, o: ['अ', 'ब', 'स', 'द'], s: `व्याख्या ${id}` },
  },
});

describe('mock tests and attempts', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => ({ app, prisma } = await createApp()));
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.exam.create({ data: { id: 'cgpsc', nameEn: 'C', nameHi: 'C', shortEn: 'C', shortHi: 'C', correctMarks: 2, negativeFrac: 1 / 3 } });
    await prisma.subject.create({ data: { code: 'S1', nameEn: 's', nameHi: 's' } });
    await prisma.topic.create({ data: { code: 'T1', subjectCode: 'S1', nameEn: 't', nameHi: 't' } });
    await prisma.question.createMany({ data: ['q1', 'q2', 'q3', 'q4'].map((id, i) => Q(id, i)) });
    for (const [id, access] of [['free1', AccessLevel.free], ['paid1', AccessLevel.paid]] as const) {
      await prisma.test.create({
        data: {
          id,
          examId: 'cgpsc',
          title: { en: id, hi: id },
          kind: 'mock',
          access,
          durationMin: 10,
          published: true,
          shuffle: false,
          attemptLimit: id === 'free1' ? 2 : null,
          questions: { create: ['q1', 'q2', 'q3', 'q4'].map((questionId, position) => ({ questionId, position })) },
        },
      });
    }
  });

  it('lists tests and marks paid ones as locked for free users', async () => {
    const s = await login(app, 'stu');
    const res = await http().get('/v1/tests').set(bearer(s.body.accessToken)).expect(200);
    const byId = Object.fromEntries(res.body.map((t: { id: string }) => [t.id, t]));
    expect(byId.free1.locked).toBe(false);
    expect(byId.paid1.locked).toBe(true);
    expect(byId.free1.questionCount).toBe(4);
  });

  it('requires authentication', async () => {
    await http().get('/v1/tests').expect(401);
    await http().post('/v1/tests/free1/attempts').expect(401);
  });

  it('starts an attempt without leaking answers or explanations', async () => {
    const s = await login(app, 'stu');
    const res = await http().post('/v1/tests/free1/attempts').set(bearer(s.body.accessToken)).expect(200);
    expect(res.body.questions).toHaveLength(4);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('explanation');
    expect(raw).not.toContain('"answer"');
    expect(raw).not.toContain('correctOption');
    expect(new Date(res.body.deadlineAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('resuming returns the same attempt with saved answers', async () => {
    const s = await login(app, 'stu');
    const h = bearer(s.body.accessToken);
    const a = await http().post('/v1/tests/free1/attempts').set(h).expect(200);
    await http().put(`/v1/attempts/${a.body.attemptId}/answers`).set(h).send({ answers: [{ questionId: 'q1', selected: 0, timeSpentSec: 5 }] }).expect(200);
    const again = await http().post('/v1/tests/free1/attempts').set(h).expect(200);
    expect(again.body.attemptId).toBe(a.body.attemptId);
    expect(again.body.answers).toEqual([{ questionId: 'q1', selected: 0, flagged: false, timeSpentSec: 5 }]);
  });

  it('scores with negative marking on submit and is idempotent', async () => {
    const s = await login(app, 'stu');
    const h = bearer(s.body.accessToken);
    const a = await http().post('/v1/tests/free1/attempts').set(h).expect(200);
    // answers: q1 correct(0), q2 wrong(0 vs 1), q3 correct(2), q4 skipped
    await http()
      .put(`/v1/attempts/${a.body.attemptId}/answers`)
      .set(h)
      .send({ answers: [{ questionId: 'q1', selected: 0 }, { questionId: 'q2', selected: 0 }, { questionId: 'q3', selected: 2 }, { questionId: 'q4', selected: null }] })
      .expect(200);
    const r = await http().post(`/v1/attempts/${a.body.attemptId}/submit`).set(h).expect(200);
    expect(r.body).toMatchObject({ status: 'submitted', correct: 2, wrong: 1, unattempted: 1, maxScore: 8, score: 3.33 });
    expect(r.body.review[0]).toMatchObject({ correctOption: 0, selected: 0 });
    expect(JSON.stringify(r.body.review[0].body)).toContain('explanation');

    const again = await http().post(`/v1/attempts/${a.body.attemptId}/submit`).set(h).expect(200);
    expect(again.body.score).toBe(3.33);
    // After submit no further answers are accepted.
    const late = await http().put(`/v1/attempts/${a.body.attemptId}/answers`).set(h).send({ answers: [{ questionId: 'q4', selected: 3 }] }).expect(409);
    expect(late.body.error.code).toBe('ATTEMPT_CLOSED');
  });

  it('validates answers', async () => {
    const s = await login(app, 'stu');
    const h = bearer(s.body.accessToken);
    const a = await http().post('/v1/tests/free1/attempts').set(h).expect(200);
    const url = `/v1/attempts/${a.body.attemptId}/answers`;
    await http().put(url).set(h).send({ answers: [{ questionId: 'q1', selected: 7 }] }).expect(400);
    const unknown = await http().put(url).set(h).send({ answers: [{ questionId: 'zzz', selected: 1 }] }).expect(400);
    expect(unknown.body.error.code).toBe('UNKNOWN_QUESTION');
    await http().put('/v1/attempts/not-a-uuid/answers').set(h).send({ answers: [] }).expect(400);
  });

  it("does not let one user touch another user's attempt", async () => {
    const a = await login(app, 'alice');
    const b = await login(app, 'bob');
    const att = await http().post('/v1/tests/free1/attempts').set(bearer(a.body.accessToken)).expect(200);
    await http().post(`/v1/attempts/${att.body.attemptId}/submit`).set(bearer(b.body.accessToken)).expect(404);
    await http().get(`/v1/attempts/${att.body.attemptId}`).set(bearer(b.body.accessToken)).expect(404);
  });

  it('hides the result until submission while time remains', async () => {
    const s = await login(app, 'stu');
    const h = bearer(s.body.accessToken);
    const a = await http().post('/v1/tests/free1/attempts').set(h).expect(200);
    const res = await http().get(`/v1/attempts/${a.body.attemptId}`).set(h).expect(409);
    expect(res.body.error.code).toBe('NOT_SUBMITTED');
  });

  it('auto-submits an attempt whose time ran out', async () => {
    const s = await login(app, 'stu');
    const h = bearer(s.body.accessToken);
    const a = await http().post('/v1/tests/free1/attempts').set(h).expect(200);
    await http().put(`/v1/attempts/${a.body.attemptId}/answers`).set(h).send({ answers: [{ questionId: 'q1', selected: 0 }] }).expect(200);
    await prisma.attempt.update({ where: { id: a.body.attemptId }, data: { deadlineAt: new Date(Date.now() - 120_000) } });
    const late = await http().put(`/v1/attempts/${a.body.attemptId}/answers`).set(h).send({ answers: [{ questionId: 'q2', selected: 1 }] }).expect(409);
    expect(late.body.error.code).toBe('ATTEMPT_EXPIRED');
    const r = await http().get(`/v1/attempts/${a.body.attemptId}`).set(h).expect(200);
    expect(r.body).toMatchObject({ status: 'expired', correct: 1, unattempted: 3, score: 2 });
  });

  it('enforces the attempt limit', async () => {
    const s = await login(app, 'stu');
    const h = bearer(s.body.accessToken);
    for (let i = 0; i < 2; i++) {
      const a = await http().post('/v1/tests/free1/attempts').set(h).expect(200);
      await http().post(`/v1/attempts/${a.body.attemptId}/submit`).set(h).expect(200);
    }
    const res = await http().post('/v1/tests/free1/attempts').set(h).expect(409);
    expect(res.body.error.code).toBe('ATTEMPT_LIMIT');
  });

  it('blocks paid tests without an entitlement and allows them with one', async () => {
    const s = await login(app, 'stu');
    const h = bearer(s.body.accessToken);
    const blocked = await http().post('/v1/tests/paid1/attempts').set(h).expect(403);
    expect(blocked.body.error.code).toBe('PAYMENT_REQUIRED');

    await prisma.plan.create({ data: { id: 'p', nameEn: 'p', nameHi: 'p', prices: { '3': 1 } } });
    await prisma.entitlement.create({
      data: { userId: s.body.user.id, planId: 'p', endsAt: new Date(Date.now() + 86_400_000), source: 'admin' },
    });
    await http().post('/v1/tests/paid1/attempts').set(h).expect(200);
  });

  it('an expired entitlement no longer unlocks paid tests', async () => {
    const s = await login(app, 'stu');
    await prisma.plan.create({ data: { id: 'p', nameEn: 'p', nameHi: 'p', prices: { '3': 1 } } });
    await prisma.entitlement.create({
      data: { userId: s.body.user.id, planId: 'p', startsAt: new Date(Date.now() - 2e9), endsAt: new Date(Date.now() - 1000), source: 'admin' },
    });
    await http().post('/v1/tests/paid1/attempts').set(bearer(s.body.accessToken)).expect(403);
  });

  it('a plan limited to other exams does not unlock this exam', async () => {
    const s = await login(app, 'stu');
    await prisma.exam.create({ data: { id: 'si', nameEn: 'S', nameHi: 'S', shortEn: 'S', shortHi: 'S' } });
    await prisma.plan.create({ data: { id: 'si_only', nameEn: 'p', nameHi: 'p', prices: { '3': 1 }, exams: { create: [{ examId: 'si' }] } } });
    await prisma.entitlement.create({
      data: { userId: s.body.user.id, planId: 'si_only', endsAt: new Date(Date.now() + 86_400_000), source: 'admin' },
    });
    await http().post('/v1/tests/paid1/attempts').set(bearer(s.body.accessToken)).expect(403);
  });

  it('live tests honour the start and entry-close window', async () => {
    const s = await login(app, 'stu');
    const h = bearer(s.body.accessToken);
    await prisma.test.update({ where: { id: 'free1' }, data: { mode: 'live', startsAt: new Date(Date.now() + 3_600_000), endsAt: new Date(Date.now() + 7_200_000) } });
    expect((await http().post('/v1/tests/free1/attempts').set(h).expect(409)).body.error.code).toBe('NOT_OPEN');
    await prisma.test.update({ where: { id: 'free1' }, data: { startsAt: new Date(Date.now() - 7_200_000), endsAt: new Date(Date.now() - 3_600_000) } });
    expect((await http().post('/v1/tests/free1/attempts').set(h).expect(409)).body.error.code).toBe('ENTRY_CLOSED');
  });

  it('an unpublished test does not exist for students', async () => {
    const s = await login(app, 'stu');
    await prisma.test.update({ where: { id: 'free1' }, data: { published: false } });
    await http().post('/v1/tests/free1/attempts').set(bearer(s.body.accessToken)).expect(404);
  });
});
