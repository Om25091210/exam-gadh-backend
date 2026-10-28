import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { baseTaxonomy, makeTest } from './fixtures';
import { createApp, FakeClock, resetDb, signedInAdmin } from './helpers';

const single = (stem: string, extra: object = {}) => ({ type: 'single', topicCode: 'T1', difficulty: 2, answer: 1, body: { en: { stem, options: ['a', 'b', 'c', 'd'], explanation: 'because' } }, ...extra });
const bilingual = (stem: string) => ({ ...single(stem), body: { en: { stem, options: ['a', 'b', 'c', 'd'] }, hi: { stem: `${stem} (hi)`, options: ['अ', 'ब', 'स', 'द'] } } });

describe('admin: question bank', () => {
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

  async function team() {
    return {
      editor: await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR'),
      admin: await signedInAdmin(app, prisma, clock, 'ADMIN'),
      teacher: await signedInAdmin(app, prisma, clock, 'TEACHER'),
      support: await signedInAdmin(app, prisma, clock, 'SUPPORT'),
    };
  }

  describe('create and validate', () => {
    it('creates one question of each type and stores a sanitised, versioned draft', async () => {
      const { editor } = await team();
      const bodies: Array<[string, object]> = [
        ['single', { en: { stem: 'Q', options: ['a', 'b', 'c', 'd'] } }],
        ['multi_statement', { en: { stem: 'Consider:', statements: ['s1', 's2'], options: ['1', '2', 'both', 'none'] } }],
        ['match', { en: { stem: 'Match', listA: ['a', 'b'], listB: ['1', '2'], options: ['A1B2', 'A2B1', 'x', 'y'] } }],
        ['assertion_reason', { en: { assertion: 'A', reason: 'R', options: ['1', '2', '3', '4'] } }],
        ['chronology', { en: { stem: 'Order', items: ['a', 'b', 'c'], options: ['abc', 'acb', 'bac', 'cab'] } }],
      ];
      for (const [i, [type, body]] of bodies.entries()) {
        const res = await http().post('/v1/admin/questions').set(editor.headers).send({ type, topicCode: 'T1', answer: 0, body, tags: ['t'], code: `TYPE-${i}` }).expect(201);
        expect(res.body).toMatchObject({ type, status: 'draft', version: 1, hasEn: true, hasHi: false });
      }
      const passage = await http().post('/v1/admin/questions').set(editor.headers).send({ type: 'passage', topicCode: 'T2', answer: 2, body: { en: { stem: 'About the passage?', options: ['a', 'b', 'c', 'd'] } }, passage: { en: 'A <script>alert(1)</script>passage.' } }).expect(201);
      const full = await http().get(`/v1/admin/questions/${passage.body.id}`).set(editor.headers).expect(200);
      expect(full.body.passage.body.en).toBe('Apassage.'.replace('A', 'A alert(1)')); // tags stripped, text kept
      expect(full.body.history).toHaveLength(1);
    });

    it('rejects invalid bodies with field-level errors', async () => {
      const { editor } = await team();
      const post = (b: object) => http().post('/v1/admin/questions').set(editor.headers).send(b);
      const r = await post({ ...single('Q'), body: { en: { stem: 'Q', options: ['a', 'b'] } } }).expect(400);
      expect(r.body.error.details[0]).toMatchObject({ field: 'en.options' });
      await post({ ...single('Q'), body: {} }).expect(400);
      await post({ ...single('Q'), answer: 4 }).expect(400);
      await post({ ...single('Q'), topicCode: 'NOPE' }).expect(400);
      expect((await post({ ...single('Q'), subtopicCode: 'NOPE' }).expect(400)).body.error.code).toBe('UNKNOWN_SUBTOPIC');
      await post({ ...single('Q'), type: 'passage' }).expect(400); // passage required
      await post({ ...single('Q'), source: 'pyq' }).expect(400); // year required
      await post({ ...single('Q'), imageKey: '../../etc/passwd' }).expect(400);
      await post({ ...single('Q'), unexpected: true }).expect(201); // unknown keys are ignored by the schema, never stored
    });

    it('enforces roles: teacher and support cannot write; editor can', async () => {
      const { editor, teacher, support } = await team();
      await http().post('/v1/admin/questions').set(teacher.headers).send(single('Q')).expect(403);
      await http().post('/v1/admin/questions').set(support.headers).send(single('Q')).expect(403);
      await http().get('/v1/admin/questions').set(support.headers).expect(403); // support has no content:read
      await http().get('/v1/admin/questions').set(teacher.headers).expect(200);
      await http().post('/v1/admin/questions').set(editor.headers).send(single('Q')).expect(201);
    });
  });

  describe('duplicates', () => {
    it('refuses a duplicate unless allowed, and reports groups', async () => {
      const { editor } = await team();
      const first = await http().post('/v1/admin/questions').set(editor.headers).send(single('What is the capital?')).expect(201);
      const dup = await http().post('/v1/admin/questions').set(editor.headers).send(single('what is  the CAPITAL')).expect(409);
      expect(dup.body.error).toMatchObject({ code: 'DUPLICATE_QUESTION', details: { duplicates: [{ id: first.body.id }] } });
      const chk = await http().post('/v1/admin/questions/check-duplicate').set(editor.headers).send({ type: 'single', body: single('What is the capital?').body }).expect(200);
      expect(chk.body.duplicates).toHaveLength(1);
      await http().post('/v1/admin/questions?allowDuplicate=true').set(editor.headers).send(single('what is the capital')).expect(201);
      const groups = await http().get('/v1/admin/questions/duplicates').set(editor.headers).expect(200);
      expect(groups.body).toHaveLength(1);
      expect(groups.body[0].ids).toHaveLength(2);
    });

    it('editing a question into a duplicate is refused too, but saving it unchanged is fine', async () => {
      const { editor } = await team();
      const a = await http().post('/v1/admin/questions').set(editor.headers).send(single('First')).expect(201);
      const b = await http().post('/v1/admin/questions').set(editor.headers).send(single('Second')).expect(201);
      await http().put(`/v1/admin/questions/${b.body.id}`).set(editor.headers).send(single('First')).expect(409);
      await http().put(`/v1/admin/questions/${a.body.id}`).set(editor.headers).send(single('First')).expect(200);
    });
  });

  describe('workflow (maker / checker)', () => {
    it('an editor submits for review but only a publisher can publish, unpublish or archive', async () => {
      const { editor, admin } = await team();
      const q = (await http().post('/v1/admin/questions').set(editor.headers).send(single('Q1')).expect(201)).body;
      const status = (who: { headers: Record<string, string> }, to: string) => http().post(`/v1/admin/questions/${q.id}/status`).set(who.headers).send({ to });
      expect((await status(editor, 'published').expect(403)).body.error.details.required).toBe('content:publish');
      expect((await status(editor, 'in_review').expect(200)).body.status).toBe('in_review');
      await status(editor, 'draft').expect(403);
      expect((await status(admin, 'published').expect(200)).body.status).toBe('published');
      await status(editor, 'archived').expect(403);
      expect((await status(admin, 'archived').expect(200)).body.status).toBe('archived');
      expect((await status(admin, 'published').expect(409)).body.error.code).toBe('INVALID_TRANSITION');
      const actions = (await prisma.auditLog.findMany({ where: { target: q.id } })).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['question.created', 'question.in_review', 'question.published', 'question.archived']));
    });

    it('an editor editing a published question sends it back for review; a publisher keeps it live; versions are kept', async () => {
      const { editor, admin } = await team();
      const q = (await http().post('/v1/admin/questions').set(admin.headers).send(single('Original')).expect(201)).body;
      await http().post(`/v1/admin/questions/${q.id}/status`).set(admin.headers).send({ to: 'published' }).expect(200);
      const e = await http().put(`/v1/admin/questions/${q.id}`).set(editor.headers).send(single('Edited by editor', { answer: 2 })).expect(200);
      expect(e.body).toMatchObject({ status: 'in_review', version: 2, answer: 2 });
      await http().post(`/v1/admin/questions/${q.id}/status`).set(admin.headers).send({ to: 'published' }).expect(200);
      const a = await http().put(`/v1/admin/questions/${q.id}`).set(admin.headers).send(single('Edited by admin', { answer: 3 })).expect(200);
      expect(a.body).toMatchObject({ status: 'published', version: 3 });
      const unchanged = await http().put(`/v1/admin/questions/${q.id}`).set(admin.headers).send(single('Edited by admin', { answer: 3 })).expect(200);
      expect(unchanged.body.version).toBe(3); // no change, no new version
      const full = await http().get(`/v1/admin/questions/${q.id}`).set(admin.headers).expect(200);
      expect(full.body.history.map((h: { version: number }) => h.version)).toEqual([3, 2, 1]);
    });

    it('publishing needs both languages when the setting is on, and shows what is missing', async () => {
      const { editor, admin } = await team();
      const one = (await http().post('/v1/admin/questions').set(editor.headers).send(single('English only')).expect(201)).body;
      const both = (await http().post('/v1/admin/questions').set(editor.headers).send(bilingual('Both')).expect(201)).body;
      await http().post(`/v1/admin/questions/${one.id}/status`).set(admin.headers).send({ to: 'published' }).expect(200); // allowed by default
      await app.get(SettingsService).set('content.requireBothLanguages', true);
      const one2 = (await http().post('/v1/admin/questions').set(editor.headers).send(single('English only again')).expect(201)).body;
      const r = await http().post(`/v1/admin/questions/${one2.id}/status`).set(admin.headers).send({ to: 'published' }).expect(409);
      expect(r.body.error).toMatchObject({ code: 'TRANSLATION_MISSING', details: { hasEn: true, hasHi: false } });
      await http().post(`/v1/admin/questions/${both.id}/status`).set(admin.headers).send({ to: 'published' }).expect(200);
    });

    it('bulk status change reports every question separately', async () => {
      const { editor, admin } = await team();
      const ids: string[] = [];
      for (const s of ['A1', 'A2', 'A3']) ids.push((await http().post('/v1/admin/questions').set(editor.headers).send(single(s)).expect(201)).body.id);
      await http().post(`/v1/admin/questions/${ids[2]}/status`).set(admin.headers).send({ to: 'published' }).expect(200);
      const r = await http().post('/v1/admin/questions/bulk-status').set(admin.headers).send({ ids: [...ids, '00000000-0000-4000-8000-000000000000'], to: 'published' }).expect(200);
      expect(r.body).toMatchObject({ changed: 3, failed: 1 }); // the one already published counts as ok
      expect(r.body.results.at(-1)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      const denied = await http().post('/v1/admin/questions/bulk-status').set(editor.headers).send({ ids: [ids[0]], to: 'archived' }).expect(200);
      expect(denied.body.results[0].error.code).toBe('FORBIDDEN');
      await http().post('/v1/admin/questions/bulk-status').set(editor.headers).send({ ids: [], to: 'published' }).expect(400);
    });

    it('only unused drafts can be deleted', async () => {
      const { editor, admin } = await team();
      const q = (await http().post('/v1/admin/questions').set(editor.headers).send(single('Gone')).expect(201)).body;
      await http().delete(`/v1/admin/questions/${q.id}`).set(editor.headers).expect(204);
      await http().get(`/v1/admin/questions/${q.id}`).set(editor.headers).expect(404);
      const live = (await http().post('/v1/admin/questions').set(admin.headers).send(single('Live')).expect(201)).body;
      await http().post(`/v1/admin/questions/${live.id}/status`).set(admin.headers).send({ to: 'published' }).expect(200);
      expect((await http().delete(`/v1/admin/questions/${live.id}`).set(admin.headers).expect(409)).body.error.code).toBe('NOT_DRAFT');
      // a question frozen into a test can never be deleted
      const t = await makeTest(prisma, { n: 1 });
      await prisma.question.update({ where: { id: t.questionIds[0] }, data: { status: 'draft' } });
      expect((await http().delete(`/v1/admin/questions/${t.questionIds[0]}`).set(admin.headers).expect(409)).body.error.code).toBe('IN_USE');
    });
  });

  describe('find things', () => {
    it('filters by translation, status, topic, text and report count, with pagination', async () => {
      const { editor } = await team();
      const mk = (b: object) => http().post('/v1/admin/questions').set(editor.headers).send(b).expect(201);
      await mk(single('Mahanadi river question', { topicCode: 'T1' }));
      await mk(bilingual('Constitution article'));
      await mk(single('Another English one', { topicCode: 'T2', difficulty: 3 }));
      const get = (qs: string) => http().get(`/v1/admin/questions?${qs}`).set(editor.headers).expect(200).then((r) => r.body);
      expect((await get('missing=hi')).total).toBe(2);
      expect((await get('missing=en')).total).toBe(0);
      expect((await get('missing=any')).total).toBe(2);
      expect((await get('topicCode=T2')).total).toBe(1);
      expect((await get('difficulty=3')).total).toBe(1);
      expect((await get('q=mahanadi')).items[0].preview).toContain('Mahanadi');
      expect((await get('q=MAHANADI')).total).toBe(1);
      expect((await get('status=published')).total).toBe(0);
      const p = await get('pageSize=2&page=2');
      expect(p).toMatchObject({ total: 3, page: 2 });
      expect(p.items).toHaveLength(1);
      await http().get('/v1/admin/questions?pageSize=1000').set(editor.headers).expect(400);
      await http().get('/v1/admin/questions?status=bogus').set(editor.headers).expect(400);
    });
  });

  describe('student-reported issues', () => {
    it('lists open reports, resolves them, and keeps the question counter right', async () => {
      const { editor, admin, teacher, support } = await team();
      const q = (await http().post('/v1/admin/questions').set(admin.headers).send(single('Reported')).expect(201)).body;
      const student = await prisma.user.create({ data: { googleSub: 's', email: 's@x.in', name: 'S' } });
      const rep = await prisma.questionReport.create({ data: { questionId: q.id, userId: student.id, reason: 'wrong_answer', note: 'key looks wrong' } });
      await prisma.question.update({ where: { id: q.id }, data: { reportedCount: 1 } });
      expect((await http().get('/v1/admin/questions?reported=true').set(editor.headers).expect(200)).body.total).toBe(1);
      expect((await http().get('/v1/admin/question-reports').set(support.headers).expect(200)).body.items).toHaveLength(1);
      await http().patch(`/v1/admin/question-reports/${rep.id}`).set(teacher.headers).send({ status: 'resolved' }).expect(403); // teacher may read, not resolve
      await http().patch(`/v1/admin/question-reports/${rep.id}`).set(editor.headers).send({ status: 'resolved', note: 'fixed in v2' }).expect(200);
      expect((await prisma.question.findUniqueOrThrow({ where: { id: q.id } })).reportedCount).toBe(0);
      expect((await http().patch(`/v1/admin/question-reports/${rep.id}`).set(editor.headers).send({ status: 'dismissed' }).expect(409)).body.error.code).toBe('ALREADY_HANDLED');
      expect((await http().get('/v1/admin/question-reports').set(editor.headers).expect(200)).body.items).toHaveLength(0);
    });
  });

  it('shares one passage between several questions', async () => {
    const { editor } = await team();
    const p = (await http().post('/v1/admin/passages').set(editor.headers).send({ en: 'Shared text', hi: 'साझा पाठ' }).expect(201)).body;
    const mk = (stem: string) => http().post('/v1/admin/questions').set(editor.headers).send({ type: 'passage', topicCode: 'T1', answer: 0, passageId: p.id, body: { en: { stem, options: ['a', 'b', 'c', 'd'] } } }).expect(201);
    await mk('First about the text?');
    await mk('Second about the text?');
    expect((await http().get(`/v1/admin/passages/${p.id}`).set(editor.headers).expect(200)).body.questions).toHaveLength(2);
    await http().post('/v1/admin/questions').set(editor.headers).send({ type: 'passage', topicCode: 'T1', answer: 0, passageId: '00000000-0000-4000-8000-000000000000', body: { en: { stem: 'x?', options: ['a', 'b', 'c', 'd'] } } }).expect(400);
  });
});
