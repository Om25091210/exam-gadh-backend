import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { baseTaxonomy, makeQuestions, makeTest } from './fixtures';
import { bearer, createApp, FakeClock, login, resetDb, signedInAdmin } from './helpers';

describe('admin: test builder, publishing, versions, key correction, analytics', () => {
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
  const base = { examId: 'cgpsc', paperId: 'cgpsc_pre_gs', titleEn: 'Mock 1', titleHi: 'मॉक 1', kind: 'mock' };

  async function staff() {
    return { editor: await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR'), admin: await signedInAdmin(app, prisma, clock, 'ADMIN'), teacher: await signedInAdmin(app, prisma, clock, 'TEACHER') };
  }
  async function draftTest(who: { headers: Record<string, string> }, body: object = {}) {
    const r = await http().post('/v1/admin/tests').set(who.headers).send({ ...base, ...body }).expect(201);
    return { testId: r.body.test.id as string, versionId: r.body.version.id as string };
  }

  describe('create', () => {
    it('takes the exam paper pattern as defaults and lets the admin override any of it', async () => {
      const { editor } = await staff();
      const r = await http().post('/v1/admin/tests').set(editor.headers).send(base).expect(201);
      expect(r.body.version).toMatchObject({ version: 1, status: 'draft', durationMin: 10, correctMarks: 2, shuffleQuestions: true });
      expect(r.body.version.negativeFraction).toBeCloseTo(1 / 3);
      const o = await http().post('/v1/admin/tests').set(editor.headers).send({ ...base, titleEn: 'Custom', config: { durationMin: 45, correctMarks: 1, negativeFraction: 0.25, attemptLimit: 3 } }).expect(201);
      expect(o.body.version).toMatchObject({ durationMin: 45, correctMarks: 1, negativeFraction: 0.25, attemptLimit: 3 });
    });

    it('validates the request and the role', async () => {
      const { editor, teacher } = await staff();
      const post = (b: object, who = editor) => http().post('/v1/admin/tests').set(who.headers).send(b);
      await post(base, teacher).expect(403);
      expect((await post({ ...base, examId: 'nope' }).expect(400)).body.error.code).toBe('UNKNOWN_EXAM');
      expect((await post({ ...base, paperId: 'cgpsc_missing' }).expect(400)).body.error.code).toBe('UNKNOWN_PAPER');
      expect((await post({ ...base, kind: 'live' }).expect(400)).body.error.code).toBe('KIND_MODE_MISMATCH');
      expect((await post({ ...base, paperId: undefined }).expect(400)).body.error.code).toBe('DURATION_REQUIRED');
      await post({ ...base, kind: 'bogus' }).expect(400);
      await post({ ...base, titleEn: '' }).expect(400);
    });
  });

  describe('draft editing', () => {
    it('sets sections and questions, validates them, and reports what blocks publishing', async () => {
      const { editor } = await staff();
      const t = await draftTest(editor);
      const qs = await makeQuestions(prisma, 6);
      await prisma.question.update({ where: { id: qs[5] }, data: { status: 'draft' } });
      const url = `/v1/admin/tests/${t.testId}/versions/${t.versionId}`;
      await http().put(`${url}/sections`).set(editor.headers).send({ sections: [{ nameEn: 'GK', nameHi: 'सामान्य ज्ञान' }, { nameEn: 'Polity', nameHi: 'राजव्यवस्था' }] }).expect(200);
      const items = qs.map((q, i) => ({ questionId: q, sectionPos: i < 3 ? 0 : 1 }));
      const set = (body: object) => http().put(`${url}/questions`).set(editor.headers).send(body);
      expect((await set({ items: [items[0], items[0]] }).expect(400)).body.error.code).toBe('DUPLICATE_QUESTION');
      expect((await set({ items: [{ questionId: '00000000-0000-4000-8000-000000000000', sectionPos: 0 }] }).expect(400)).body.error.code).toBe('UNKNOWN_QUESTION');
      expect((await set({ items: [{ questionId: qs[0] }] }).expect(400)).body.error.code).toBe('SECTION_REQUIRED');
      expect((await set({ items: [{ questionId: qs[0], sectionPos: 5 }] }).expect(400)).body.error.code).toBe('UNKNOWN_SECTION');
      const ok = await set({ items }).expect(200);
      expect(ok.body).toMatchObject({ count: 6 });
      expect(ok.body.notPublished).toHaveLength(1);
      const v = (await http().get(url).set(editor.headers).expect(200)).body;
      expect(v.items.map((i: { sectionPos: number }) => i.sectionPos)).toEqual([0, 0, 0, 1, 1, 1]);
      expect(v.totalMarks).toBe(12);
      expect(v.readiness).toMatchObject({ ready: false });
      expect(v.readiness.problems[0]).toContain('is draft');
    });

    it('an archived question cannot be added', async () => {
      const { editor } = await staff();
      const t = await draftTest(editor);
      const [q] = await makeQuestions(prisma, 1);
      await prisma.question.update({ where: { id: q }, data: { status: 'archived' } });
      expect((await http().put(`/v1/admin/tests/${t.testId}/versions/${t.versionId}/questions`).set(editor.headers).send({ items: [{ questionId: q }] }).expect(400)).body.error.code).toBe('ARCHIVED_QUESTION');
    });

    it('rule-based picking: counts by topic and difficulty, no repeats, repeatable with a seed, clear shortages', async () => {
      const { editor } = await staff();
      const t = await draftTest(editor);
      const qs = await makeQuestions(prisma, 20); // even index -> T1, odd -> T2
      for (const [i, q] of qs.entries()) await prisma.question.update({ where: { id: q }, data: { difficulty: (i % 3) + 1 } });
      const url = `/v1/admin/tests/${t.testId}/versions/${t.versionId}/pick`;
      const pick = (b: object) => http().post(url).set(editor.headers).send(b);
      const preview = (await pick({ rules: [{ topicCode: 'T1', count: 4 }, { topicCode: 'T2', difficulty: 1, count: 2 }], seed: 'abc', preview: true }).expect(200)).body;
      const again = (await pick({ rules: [{ topicCode: 'T1', count: 4 }, { topicCode: 'T2', difficulty: 1, count: 2 }], seed: 'abc', preview: true }).expect(200)).body;
      expect(preview.questionIds).toEqual(again.questionIds);
      expect(preview.picked).toBe(6);
      expect(await prisma.testVersionQuestion.count({ where: { versionId: t.versionId } })).toBe(0); // preview saves nothing

      const real = (await pick({ rules: [{ topicCode: 'T1', count: 4 }, { topicCode: 'T2', difficulty: 1, count: 2 }], seed: 'abc' }).expect(200)).body;
      expect(real.picked).toBe(6);
      const saved = await prisma.testVersionQuestion.findMany({ where: { versionId: t.versionId }, include: {} });
      const bank = await prisma.question.findMany({ where: { id: { in: saved.map((s) => s.questionId) } } });
      expect(bank.filter((q) => q.topicCode === 'T1')).toHaveLength(4);
      expect(bank.filter((q) => q.topicCode === 'T2' && q.difficulty === 1)).toHaveLength(2);
      // a second pick never repeats a question that is already in the test
      await pick({ rules: [{ topicCode: 'T1', count: 6 }], seed: 'x' }).expect(200);
      const all = await prisma.testVersionQuestion.findMany({ where: { versionId: t.versionId } });
      expect(new Set(all.map((a) => a.questionId)).size).toBe(all.length);
      const short = await pick({ rules: [{ topicCode: 'T1', count: 50 }] }).expect(409);
      expect(short.body.error).toMatchObject({ code: 'NOT_ENOUGH_QUESTIONS', details: { shortages: [{ rule: 0, requested: 50, available: expect.any(Number) }] } });
      // T1 is used up by now; T2 still has 8 unused questions, so a partial pick adds exactly those
      expect((await pick({ rules: [{ topicCode: 'T1', count: 50 }], allowPartial: true }).expect(200)).body.picked).toBe(0);
      expect((await pick({ rules: [{ topicCode: 'T2', count: 50 }], allowPartial: true }).expect(200)).body).toMatchObject({ picked: 8, shortages: [{ requested: 50, available: 8 }] });
      expect((await pick({ rules: [{ topicCode: 'T1', count: 1 }], seed: 's', preview: true }).expect(409)).body.error.code).toBe('NOT_ENOUGH_QUESTIONS'); // nothing unused is left
      await pick({ rules: [] }).expect(400);
    });
  });

  describe('publishing and versions', () => {
    async function readyTest(who: { headers: Record<string, string> }) {
      const t = await draftTest(who);
      const qs = await makeQuestions(prisma, 4);
      await http().put(`/v1/admin/tests/${t.testId}/versions/${t.versionId}/questions`).set(who.headers).send({ items: qs.map((q) => ({ questionId: q })) }).expect(200);
      return { ...t, qs };
    }

    it('only a publisher can publish; the published version is locked; students then see it', async () => {
      const { editor, admin } = await staff();
      const t = await readyTest(editor);
      const pub = `/v1/admin/tests/${t.testId}/versions/${t.versionId}/publish`;
      expect((await http().post(pub).set(editor.headers).expect(403)).body.error.details.required).toBe('test:publish');
      const published = await http().post(pub).set(admin.headers).expect(200);
      expect(published.body).toMatchObject({ status: 'published', maxScore: 8, questionCount: 4 });
      expect((await http().post(pub).set(admin.headers).expect(409)).body.error.code).toBe('VERSION_LOCKED');
      expect((await http().put(`/v1/admin/tests/${t.testId}/versions/${t.versionId}`).set(editor.headers).send({ durationMin: 5 }).expect(409)).body.error.code).toBe('VERSION_LOCKED');
      await http().put(`/v1/admin/tests/${t.testId}/versions/${t.versionId}/questions`).set(editor.headers).send({ items: [] }).expect(409);
      const s = await login(app, 'stu');
      const list = await http().get('/v1/tests').set(bearer(s.body.accessToken)).expect(200);
      expect(list.body.items.map((i: { id: string }) => i.id)).toContain(t.testId);
    });

    it('refuses to publish an incomplete test and says exactly why', async () => {
      const { admin } = await staff();
      const t = await draftTest(admin);
      const r = await http().post(`/v1/admin/tests/${t.testId}/versions/${t.versionId}/publish`).set(admin.headers).expect(422);
      expect(r.body.error).toMatchObject({ code: 'PUBLISH_BLOCKED', details: [{ field: 'questions' }] });
      const [q] = await makeQuestions(prisma, 1);
      await prisma.question.update({ where: { id: q }, data: { status: 'in_review' } });
      await http().put(`/v1/admin/tests/${t.testId}/versions/${t.versionId}/questions`).set(admin.headers).send({ items: [{ questionId: q }] }).expect(200);
      const r2 = await http().post(`/v1/admin/tests/${t.testId}/versions/${t.versionId}/publish`).set(admin.headers).expect(422);
      expect(r2.body.error.details[0].message).toContain('in_review');
    });

    it('editing a published test creates a new draft; publishing it archives the old version and students move to the new one', async () => {
      const { editor, admin } = await staff();
      const t = await readyTest(editor);
      await http().post(`/v1/admin/tests/${t.testId}/versions/${t.versionId}/publish`).set(admin.headers).expect(200);
      const draft = (await http().post(`/v1/admin/tests/${t.testId}/versions`).set(editor.headers).expect(201)).body;
      expect(draft).toMatchObject({ version: 2, status: 'draft' });
      expect((await http().post(`/v1/admin/tests/${t.testId}/versions`).set(editor.headers).expect(201)).body.id).toBe(draft.id); // same draft
      await http().put(`/v1/admin/tests/${t.testId}/versions/${draft.id}`).set(editor.headers).send({ durationMin: 99 }).expect(200);
      const extra = (await makeQuestions(prisma, 1, 'X'))[0];
      await http().put(`/v1/admin/tests/${t.testId}/versions/${draft.id}/questions`).set(editor.headers).send({ items: [...t.qs, extra].map((q) => ({ questionId: q })) }).expect(200);
      await http().post(`/v1/admin/tests/${t.testId}/versions/${draft.id}/publish`).set(admin.headers).expect(200);
      const versions = await prisma.testVersion.findMany({ where: { testId: t.testId }, orderBy: { version: 'asc' } });
      expect(versions.map((v) => v.status)).toEqual(['archived', 'published']);
      const s = await login(app, 'stu');
      const d = await http().get(`/v1/tests/${t.testId}`).set(bearer(s.body.accessToken)).expect(200);
      expect(d.body).toMatchObject({ version: 2, durationMin: 99, questionCount: 5 });
      // the archived version is frozen in the database as well
      await expect(prisma.testVersionQuestion.update({ where: { id: (await prisma.testVersionQuestion.findFirstOrThrow({ where: { versionId: t.versionId } })).id }, data: { marks: 9 } })).rejects.toThrow(/frozen/);
      await expect(prisma.testVersion.update({ where: { id: t.versionId }, data: { durationMin: 1 } })).rejects.toThrow(/frozen/);
      await expect(prisma.testSection.create({ data: { versionId: t.versionId, position: 9, nameEn: 'x', nameHi: 'x' } })).rejects.toThrow(/frozen/);
    });

    it('a draft can be discarded; archive hides a test from students; unpublished or attempted tests cannot be deleted', async () => {
      const { editor, admin } = await staff();
      const t = await readyTest(editor);
      await http().post(`/v1/admin/tests/${t.testId}/versions/${t.versionId}/publish`).set(admin.headers).expect(200);
      const d2 = (await http().post(`/v1/admin/tests/${t.testId}/versions`).set(editor.headers).expect(201)).body;
      await http().delete(`/v1/admin/tests/${t.testId}/versions/${d2.id}`).set(editor.headers).expect(204);
      expect((await http().delete(`/v1/admin/tests/${t.testId}/versions/${t.versionId}`).set(editor.headers).expect(409)).body.error.code).toBe('VERSION_LOCKED');
      expect((await http().delete(`/v1/admin/tests/${t.testId}`).set(editor.headers).expect(409)).body.error.code).toBe('HAS_HISTORY');
      await http().post(`/v1/admin/tests/${t.testId}/archive`).set(editor.headers).expect(403);
      await http().post(`/v1/admin/tests/${t.testId}/archive`).set(admin.headers).expect(204);
      const s = await login(app, 'stu');
      expect((await http().get('/v1/tests').set(bearer(s.body.accessToken))).body.items).toHaveLength(0);
      await http().post(`/v1/admin/tests/${t.testId}/unarchive`).set(admin.headers).expect(204);
      expect((await http().get('/v1/tests').set(bearer(s.body.accessToken))).body.items).toHaveLength(1);
      const fresh = await draftTest(editor, { titleEn: 'Throwaway' });
      await http().delete(`/v1/admin/tests/${fresh.testId}`).set(editor.headers).expect(204);
    });

    it('lists tests with state filters and search', async () => {
      const { editor, admin } = await staff();
      const a = await readyTest(editor);
      await http().post(`/v1/admin/tests/${a.testId}/versions/${a.versionId}/publish`).set(admin.headers).expect(200);
      await draftTest(editor, { titleEn: 'Polity sectional' });
      const get = (qs: string) => http().get(`/v1/admin/tests?${qs}`).set(editor.headers).expect(200).then((r) => r.body);
      expect((await get('')).total).toBe(2);
      expect((await get('state=published')).total).toBe(1);
      expect((await get('state=draft')).items[0].titleEn).toBe('Polity sectional');
      expect((await get('q=polity')).total).toBe(1);
      expect((await get('state=archived')).total).toBe(0);
    });
  });

  describe('answer-key correction (regrade)', () => {
    async function scenario() {
      const t = await makeTest(prisma, { n: 4 }); // key: q0=0 q1=1 q2=2 q3=3
      const tvqs = await prisma.testVersionQuestion.findMany({ where: { versionId: t.versionId }, orderBy: { position: 'asc' } });
      const players: Array<{ h: Record<string, string>; attempt: string; id: string }> = [];
      // alice answers q0 with 0 (right), bob answers q0 with 3 (wrong), carol skips q0
      for (const [sub, pick] of [['alice', 0], ['bob', 3], ['carol', null]] as const) {
        const r = await login(app, sub);
        const h = bearer(r.body.accessToken);
        const a = (await http().post(`/v1/tests/${t.testId}/attempts`).set(h).expect(200)).body;
        await http().put(`/v1/attempts/${a.attemptId}/state`).set(h).send({ seq: 1, answers: [{ qid: tvqs[0].id, selected: pick, seq: 1 }] }).expect(200);
        await http().post(`/v1/attempts/${a.attemptId}/submit`).set(h).send({ submitKey: 'k' }).expect(200);
        players.push({ h, attempt: a.attemptId, id: r.body.user.id });
      }
      return { t, tvqs, players };
    }

    it('re-scores everyone who answered the question, fixes topic stats, updates the bank and is fully audited', async () => {
      const { t, tvqs, players } = await scenario();
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const before = await Promise.all(players.map((p) => prisma.attemptResult.findUniqueOrThrow({ where: { attemptId: p.attempt } })));
      expect(before.map((b) => b.score)).toEqual([2, -0.67, 0]);
      const r = await http().post(`/v1/admin/tests/${t.testId}/versions/${t.versionId}/correct-key`).set(admin.headers).send({ tvqId: tvqs[0].id, newAnswer: 3, reason: 'Official key revised' }).expect(200);
      expect(r.body).toMatchObject({ oldAnswer: 0, newAnswer: 3, attemptsRescored: 2, scoresChanged: 2 });
      const after = await Promise.all(players.map((p) => prisma.attemptResult.findUniqueOrThrow({ where: { attemptId: p.attempt } })));
      expect(after.map((b) => b.score)).toEqual([-0.67, 2, 0]); // alice and bob swap
      const stat = await prisma.userTopicStat.findUniqueOrThrow({ where: { userId_topicCode: { userId: players[0].id, topicCode: 'T1' } } });
      expect(stat.correct).toBe(0);
      const bob = await prisma.userTopicStat.findUniqueOrThrow({ where: { userId_topicCode: { userId: players[1].id, topicCode: 'T1' } } });
      expect(bob.correct).toBe(1);
      // students see the corrected key and their new rank
      const res = (await http().get(`/v1/attempts/${players[1].attempt}/result`).set(players[1].h).expect(200)).body;
      expect(res).toMatchObject({ score: 2, rank: 1 });
      const review = (await http().get(`/v1/attempts/${players[1].attempt}/review`).set(players[1].h).expect(200)).body;
      expect(review.questions.find((q: { qid: string }) => q.qid === tvqs[0].id).correctOption).toBe(3);
      // the question bank follows (new version) so future tests are right
      const q = await prisma.question.findUniqueOrThrow({ where: { id: tvqs[0].questionId } });
      expect(q).toMatchObject({ answer: 3, version: 2 });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'test.key_corrected' } });
      expect(log).toMatchObject({ actor: admin.id });
      expect(log.meta).toMatchObject({ reason: 'Official key revised', attempts: 2, scoresChanged: 2 });
    });

    it('is refused for no-op changes, drafts, unknown questions and for roles without test:publish; direct SQL edits are still blocked', async () => {
      const { t, tvqs } = await scenario();
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const editor = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
      const url = `/v1/admin/tests/${t.testId}/versions/${t.versionId}/correct-key`;
      const body = { tvqId: tvqs[0].id, newAnswer: 3, reason: 'Official key revised' };
      await http().post(url).set(editor.headers).send(body).expect(403);
      expect((await http().post(url).set(admin.headers).send({ ...body, newAnswer: 0 }).expect(409)).body.error.code).toBe('NO_CHANGE');
      await http().post(url).set(admin.headers).send({ ...body, reason: 'x' }).expect(400);
      await http().post(url).set(admin.headers).send({ ...body, tvqId: '00000000-0000-4000-8000-000000000000' }).expect(404);
      const draft = await draftTest(admin);
      expect((await http().post(`/v1/admin/tests/${draft.testId}/versions/${draft.versionId}/correct-key`).set(admin.headers).send(body).expect(400)).body.error.code).toBe('USE_QUESTION_EDIT');
      // outside the audited path the database still refuses
      await expect(prisma.$executeRaw`UPDATE "TestVersionQuestion" SET snapshot = '{}'::jsonb WHERE id = ${tvqs[0].id}::uuid`).rejects.toThrow(/frozen/);
    });
  });

  describe('analytics and export', () => {
    it('reports score statistics, a distribution and per-question difficulty, and exports a safe CSV', async () => {
      const t = await makeTest(prisma, { n: 4 });
      const tvqs = await prisma.testVersionQuestion.findMany({ where: { versionId: t.versionId }, orderBy: { position: 'asc' } });
      // 3 students: q0 answered correctly by two of them, wrongly by one; names include a spreadsheet formula
      const specs: Array<[string, string, number]> = [['a', 'Asha Verma', 0], ['b', '=cmd|calc', 0], ['c', 'Chitra Sahu', 3]];
      for (const [sub, name, pick] of specs) {
        const r = await login(app, sub, `device-${sub}-1`, 'android', name);
        const h = bearer(r.body.accessToken);
        const a = (await http().post(`/v1/tests/${t.testId}/attempts`).set(h).expect(200)).body;
        await http().put(`/v1/attempts/${a.attemptId}/state`).set(h).send({ seq: 1, answers: [{ qid: tvqs[0].id, selected: pick, seq: 1, timeSpentSec: 10 }] }).expect(200);
        await http().post(`/v1/attempts/${a.attemptId}/submit`).set(h).send({ submitKey: 'k' }).expect(200);
      }
      const teacher = await signedInAdmin(app, prisma, clock, 'TEACHER');
      const s = (await http().get(`/v1/admin/tests/${t.testId}/analytics`).set(teacher.headers).expect(200)).body;
      expect(s.attempts.rankedResults).toBe(3);
      expect(s.scores).toMatchObject({ max: 2, min: -0.67 });
      expect(s.distribution.reduce((n: number, b: { count: number }) => n + b.count, 0)).toBe(3);
      const q0 = s.questions[0];
      expect(q0).toMatchObject({ position: 1, attempted: 3, correct: 2, wrong: 1, skipped: 0, markedForReview: 0 });
      expect(q0.difficultyIndex).toBe(0.67);
      expect(s.questions[1]).toMatchObject({ attempted: 0, skipped: 3, difficultyIndex: 0 });
      expect(s.mostWrong[0].position).toBe(1);

      const csv = await http().get(`/v1/admin/tests/${t.testId}/results.csv`).set(teacher.headers).expect(200);
      expect(csv.headers['content-disposition']).toContain('results.csv');
      expect(csv.text).toContain("'=cmd|calc"); // formula neutralised
      expect(csv.text).not.toContain('@examgadh'); // no e-mail addresses
      expect(csv.text).not.toContain('@example.com');
      const support = await signedInAdmin(app, prisma, clock, 'SUPPORT');
      await http().get(`/v1/admin/tests/${t.testId}/analytics`).set(support.headers).expect(403);
      await http().get(`/v1/admin/tests/${t.testId}/results.csv`).set(support.headers).expect(403);
    });
  });

  describe('series', () => {
    it('creates a series, orders its tests, and only publishes it when it has tests', async () => {
      const { editor, admin } = await staff();
      const a = await makeTest(prisma);
      const b = await makeTest(prisma, { title: 'Second' });
      await http().post('/v1/admin/series').set(editor.headers).send({ examId: 'cgpsc', titleEn: 'S', titleHi: 'श्र' }).expect(403); // editors do not own series
      const s = (await http().post('/v1/admin/series').set(admin.headers).send({ examId: 'cgpsc', titleEn: 'CGPSC series', titleHi: 'श्रृंखला', access: 'paid' }).expect(201)).body;
      expect((await http().patch(`/v1/admin/series/${s.id}`).set(admin.headers).send({ status: 'published' }).expect(409)).body.error.code).toBe('EMPTY_SERIES');
      await http().put(`/v1/admin/series/${s.id}/items`).set(admin.headers).send({ testIds: [b.testId, a.testId] }).expect(204);
      await http().put(`/v1/admin/series/${s.id}/items`).set(admin.headers).send({ testIds: [a.testId, a.testId] }).expect(400);
      await http().put(`/v1/admin/series/${s.id}/items`).set(admin.headers).send({ testIds: ['00000000-0000-4000-8000-000000000000'] }).expect(400);
      await http().patch(`/v1/admin/series/${s.id}`).set(admin.headers).send({ status: 'published' }).expect(200);
      const full = (await http().get(`/v1/admin/series/${s.id}`).set(editor.headers).expect(200)).body;
      expect(full.items.map((i: { testId: string }) => i.testId)).toEqual([b.testId, a.testId]);
      expect((await http().post('/v1/admin/series').set(admin.headers).send({ examId: 'nope', titleEn: 'S', titleHi: 'श्र' }).expect(400)).body.error.code).toBe('UNKNOWN_EXAM');
    });
  });
});
