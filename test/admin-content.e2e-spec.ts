import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { baseTaxonomy, makeTest } from './fixtures';
import { createApp, FakeClock, resetDb, signedInAdmin } from './helpers';

describe('admin: study content', () => {
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
  const team = async () => ({ editor: await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR'), admin: await signedInAdmin(app, prisma, clock, 'ADMIN'), teacher: await signedInAdmin(app, prisma, clock, 'TEACHER'), support: await signedInAdmin(app, prisma, clock, 'SUPPORT') });

  const material = { titleEn: 'Polity notes', titleHi: 'राजव्यवस्था नोट्स', kind: 'link', url: 'https://example.com/polity', subjectCode: 'S1' };
  const ca = { date: '2026-10-27', category: 'CG', titleEn: 'State budget', titleHi: 'राज्य बजट', summaryEn: 'Summary <b>text</b>', summaryHi: 'सारांश', tags: ['budget'] };

  describe('materials: validation, search, sanitising', () => {
    it('creates, lists, searches and filters; strips markup; keeps Hindi intact', async () => {
      const { editor } = await team();
      const r = await http().post('/v1/admin/materials').set(editor.headers).send({ ...material, titleEn: 'Polity <script>alert(1)</script>notes' }).expect(201);
      expect(r.body.titleEn).toBe('Polity alert(1)notes');
      expect(r.body.titleHi).toBe('राजव्यवस्था नोट्स');
      await http().post('/v1/admin/materials').set(editor.headers).send({ ...material, titleEn: 'History PDF', titleHi: 'इतिहास', kind: 'pdf', fileKey: 'materials/history.pdf', subjectCode: 'S1', access: 'paid' }).expect(201);
      const get = (qs: string) => http().get(`/v1/admin/materials?${qs}`).set(editor.headers).expect(200).then((x) => x.body);
      expect((await get('')).total).toBe(2);
      expect((await get('q=history')).total).toBe(1);
      expect((await get('kind=pdf')).items[0].titleEn).toBe('History PDF');
      expect((await get('access=paid')).total).toBe(1);
      expect((await get('status=published')).total).toBe(0);
      expect((await get('pageSize=1&page=2')).items).toHaveLength(1);
    });

    it('rejects bad input with field-level errors', async () => {
      const { editor } = await team();
      const post = (b: object) => http().post('/v1/admin/materials').set(editor.headers).send({ ...material, ...b });
      expect((await post({ url: 'http://insecure.example.com' }).expect(400)).body.error.details[0].problems[0]).toContain('https');
      await post({ url: 'javascript:alert(1)' }).expect(400);
      await post({ kind: 'pdf', url: undefined }).expect(400); // pdf needs a file
      await post({ kind: 'pdf', fileKey: '../../etc/passwd', url: undefined }).expect(400);
      await post({ kind: 'link', url: undefined }).expect(400);
      await post({ titleEn: '' }).expect(400);
      expect((await post({ subjectCode: 'NOPE' }).expect(400)).body.error.code).toBe('UNKNOWN_REFERENCE');
      expect((await post({ examId: 'nope' }).expect(400)).body.error.code).toBe('UNKNOWN_REFERENCE');
      await post({ kind: 'bogus' }).expect(400);
    });

    it('PATCH merges with the stored item and re-validates the result', async () => {
      const { editor } = await team();
      const m = (await http().post('/v1/admin/materials').set(editor.headers).send(material).expect(201)).body;
      const r = await http().patch(`/v1/admin/materials/${m.id}`).set(editor.headers).send({ titleEn: 'Renamed' }).expect(200);
      expect(r.body).toMatchObject({ titleEn: 'Renamed', url: 'https://example.com/polity', titleHi: 'राजव्यवस्था नोट्स' });
      await http().patch(`/v1/admin/materials/${m.id}`).set(editor.headers).send({ kind: 'pdf' }).expect(400); // would leave a PDF with no file
      await http().patch(`/v1/admin/materials/${m.id}`).set(editor.headers).send({ url: 'ftp://x' }).expect(400);
      await http().patch('/v1/admin/materials/00000000-0000-4000-8000-000000000000').set(editor.headers).send({ titleEn: 'x' }).expect(404);
    });
  });

  describe('publishing workflow and scheduling', () => {
    it('editors write drafts; only publishers publish, change or unpublish live content', async () => {
      const { editor, admin } = await team();
      const m = (await http().post('/v1/admin/materials').set(editor.headers).send(material).expect(201)).body;
      const status = (who: { headers: Record<string, string> }, to: string) => http().post(`/v1/admin/materials/${m.id}/status`).set(who.headers).send({ to });
      expect((await status(editor, 'published').expect(403)).body.error.details.required).toBe('content:publish');
      await http().post('/v1/admin/materials').set(editor.headers).send({ ...material, status: 'published' }).expect(403); // cannot sneak it in on create
      expect((await status(editor, 'in_review').expect(200)).body.state).toBe('in_review');
      expect((await status(admin, 'published').expect(200)).body.state).toBe('live');
      await http().patch(`/v1/admin/materials/${m.id}`).set(editor.headers).send({ titleEn: 'Sneaky edit' }).expect(403);
      await status(editor, 'draft').expect(403);
      await http().delete(`/v1/admin/materials/${m.id}`).set(admin.headers).expect(409); // live content is unpublished, not deleted
      await http().patch(`/v1/admin/materials/${m.id}`).set(admin.headers).send({ titleEn: 'Admin edit' }).expect(200);
      expect((await status(admin, 'archived').expect(200)).body.state).toBe('archived');
      await http().delete(`/v1/admin/materials/${m.id}`).set(editor.headers).expect(204);
      const log = (await prisma.auditLog.findMany({ where: { targetType: 'material' } })).map((l) => l.action);
      expect(log).toEqual(expect.arrayContaining(['material.created', 'material.in_review', 'material.published', 'material.archived', 'material.deleted']));
    });

    it('a future publish time keeps published content "scheduled"; announcements can expire', async () => {
      const { admin } = await team();
      const soon = new Date(Date.now() + 3_600_000).toISOString();
      const m = (await http().post('/v1/admin/materials').set(admin.headers).send({ ...material, status: 'published', publishAt: soon }).expect(201)).body;
      expect((await http().get(`/v1/admin/materials/${m.id}`).set(admin.headers).expect(200)).body.state).toBe('scheduled');
      const past = new Date(Date.now() - 3_600_000).toISOString();
      const a = (await http().post('/v1/admin/announcements').set(admin.headers).send({ titleEn: 'Notice', titleHi: 'सूचना', bodyEn: 'Body', bodyHi: 'विवरण', status: 'published', publishAt: new Date(Date.now() - 7_200_000).toISOString(), expiresAt: past }).expect(201)).body;
      expect((await http().get(`/v1/admin/announcements/${a.id}`).set(admin.headers).expect(200)).body.state).toBe('expired');
      const bad = await http().post('/v1/admin/announcements').set(admin.headers).send({ titleEn: 'N', titleHi: 'स', bodyEn: 'B', bodyHi: 'ब', publishAt: soon, expiresAt: past }).expect(400);
      expect(bad.body.error.details[0].problems[0]).toContain('after the publish time');
    });
  });

  describe('current affairs, calendar, FAQs, interview, notes', () => {
    it('current affairs: sanitised, date-ordered, quiz link must exist', async () => {
      const { editor } = await team();
      const t = await makeTest(prisma, { n: 2 });
      const r = await http().post('/v1/admin/current-affairs').set(editor.headers).send({ ...ca, quizTestId: t.testId }).expect(201);
      expect(r.body.summaryEn).toBe('Summary [b]text[/b]'.replace('[b]', '').replace('[/b]', ''));
      expect(r.body).toMatchObject({ category: 'CG', status: 'draft' });
      expect((await http().post('/v1/admin/current-affairs').set(editor.headers).send({ ...ca, quizTestId: '00000000-0000-4000-8000-000000000000' }).expect(400)).body.error.code).toBe('UNKNOWN_REFERENCE');
      await http().post('/v1/admin/current-affairs').set(editor.headers).send({ ...ca, category: 'WORLD' }).expect(400);
      await http().post('/v1/admin/current-affairs').set(editor.headers).send({ ...ca, sourceUrl: 'http://x.in' }).expect(400);
      await http().post('/v1/admin/current-affairs').set(editor.headers).send({ ...ca, date: '2026-10-28', titleEn: 'Newer' }).expect(201);
      const list = (await http().get('/v1/admin/current-affairs').set(editor.headers).expect(200)).body;
      expect(list.items.map((i: { titleEn: string }) => i.titleEn)).toEqual(['Newer', 'State budget']);
      expect((await http().get('/v1/admin/current-affairs?category=NAT').set(editor.headers).expect(200)).body.total).toBe(0);
    });

    it('calendar, FAQs, interview questions', async () => {
      const { editor } = await team();
      await http().post('/v1/admin/calendar').set(editor.headers).send({ examId: 'cgpsc', stage: 'prelims', labelEn: 'Prelims', labelHi: 'प्रारंभिक', date: '2027-02-24' }).expect(201);
      await http().post('/v1/admin/calendar').set(editor.headers).send({ examId: 'nope', labelEn: 'x', labelHi: 'x', date: '2027-02-24' }).expect(400);
      await http().post('/v1/admin/calendar').set(editor.headers).send({ examId: 'cgpsc', labelEn: 'x', labelHi: 'x', date: 'not a date' }).expect(400);
      await http().post('/v1/admin/faqs').set(editor.headers).send({ keywords: 'negative marking', qEn: 'Is there negative marking?', qHi: 'क्या ऋणात्मक अंकन है?', aEn: 'Yes, one third.', aHi: 'हाँ, एक-तिहाई।' }).expect(201);
      const iq = await http().post('/v1/admin/interview').set(editor.headers).send({ examId: 'cgpsc', category: 'personal', qEn: 'Why civil services?', qHi: 'सिविल सेवा क्यों?', pointsEn: 'Public service', pointsHi: 'जनसेवा' }).expect(201);
      expect((await http().get('/v1/admin/interview?examId=cgpsc&category=personal').set(editor.headers).expect(200)).body.total).toBe(1);
      expect((await http().get('/v1/admin/faqs?q=negative').set(editor.headers).expect(200)).body.total).toBe(1);
      await http().delete(`/v1/admin/interview/${iq.body.id}`).set(editor.headers).expect(204);
    });

    it('notes: structured sections validated and sanitised; unique anchors; id fixed after creation', async () => {
      const { editor, admin } = await team();
      const note = { id: 'Polity', subjectCode: 'S1', titleEn: 'Polity', titleHi: 'राजव्यवस्था', sections: [{ anchor: 'preamble', en: { title: 'The Preamble', blocks: [{ t: 'p', x: 'Adopted <i>1949</i> <script>x</script>' }, { t: 'li', x: 'Sovereign' }] }, hi: { title: 'प्रस्तावना', blocks: [{ t: 'p', x: 'अपनाई गई' }] } }] };
      const r = await http().post('/v1/admin/notes').set(editor.headers).send(note).expect(201);
      expect(r.body.id).toBe('polity');
      expect(JSON.stringify(r.body.sections)).not.toContain('<script>');
      expect((await http().post('/v1/admin/notes').set(editor.headers).send(note).expect(409)).body.error.code).toBe('ALREADY_EXISTS');
      await http().post('/v1/admin/notes').set(editor.headers).send({ ...note, id: 'dup', sections: [note.sections[0], note.sections[0]] }).expect(400);
      await http().post('/v1/admin/notes').set(editor.headers).send({ ...note, id: 'empty', sections: [] }).expect(400);
      await http().post('/v1/admin/notes').set(editor.headers).send({ ...note, id: 'badanchor', sections: [{ anchor: 'Bad Anchor!', en: note.sections[0].en }] }).expect(400);
      await http().post('/v1/admin/notes').set(editor.headers).send({ ...note, id: 'nolang', sections: [{ anchor: 'x' }] }).expect(400);
      await http().patch('/v1/admin/notes/polity').set(editor.headers).send({ titleEn: 'Indian Polity' }).expect(200);
      expect((await http().get('/v1/admin/notes/polity').set(editor.headers).expect(200)).body.titleEn).toBe('Indian Polity');
      await http().post('/v1/admin/notes/polity/status').set(editor.headers).send({ to: 'published' }).expect(403);
      expect((await http().post('/v1/admin/notes/polity/status').set(admin.headers).send({ to: 'published' }).expect(200)).body.state).toBe('live');
      expect((await http().post('/v1/admin/notes/polity/status').set(admin.headers).send({ to: 'in_review' }).expect(400)).body.error.code).toBe('NO_SUCH_STATE');
      // a published note is what students receive
      const s = await prisma.note.findUniqueOrThrow({ where: { id: 'polity' } });
      expect(s.published).toBe(true);
    });
  });

  describe('permissions', () => {
    it('announcements and notification templates need announcements:write; editors cannot', async () => {
      const { editor, admin } = await team();
      const ann = { titleEn: 'Notice', titleHi: 'सूचना', bodyEn: 'Body', bodyHi: 'विवरण' };
      await http().post('/v1/admin/announcements').set(editor.headers).send(ann).expect(403);
      await http().post('/v1/admin/announcements').set(admin.headers).send(ann).expect(201);
      const tpl = { key: 'result.ready', titleEn: 'Result ready', titleHi: 'परिणाम तैयार', bodyEn: 'Your result is out', bodyHi: 'आपका परिणाम आ गया' };
      await http().post('/v1/admin/notification-templates').set(editor.headers).send(tpl).expect(403);
      await http().post('/v1/admin/notification-templates').set(admin.headers).send(tpl).expect(201);
      await http().post('/v1/admin/notification-templates').set(admin.headers).send({ ...tpl, key: 'Bad Key' }).expect(400);
      expect((await http().post('/v1/admin/notification-templates').set(admin.headers).send(tpl).expect(409)).body.error.code).toBe('ALREADY_EXISTS');
      await http().patch('/v1/admin/notification-templates/result.ready').set(admin.headers).send({ bodyEn: 'Out now' }).expect(200);
      expect((await http().get('/v1/admin/notification-templates/result.ready').set(editor.headers).expect(200)).body.bodyEn).toBe('Out now');
    });

    it('canned replies belong to teachers (and admins); support can read, editors cannot write', async () => {
      const { editor, admin, teacher, support } = await team();
      const reply = { title: 'Revise basics', bodyEn: 'Please revise the basics of this topic.', bodyHi: 'कृपया इस विषय की मूल बातें दोहराएँ।' };
      await http().post('/v1/admin/canned-replies').set(teacher.headers).send(reply).expect(201);
      await http().post('/v1/admin/canned-replies').set(editor.headers).send(reply).expect(403);
      expect((await http().get('/v1/admin/canned-replies').set(support.headers).expect(200)).body.total).toBe(1);
      await http().get('/v1/admin/canned-replies').set(editor.headers).expect(403);
      await http().post('/v1/admin/canned-replies').set(admin.headers).send({ ...reply, title: 'Second' }).expect(201);
    });

    it('teachers and support cannot manage study material', async () => {
      const { teacher, support } = await team();
      await http().post('/v1/admin/materials').set(teacher.headers).send(material).expect(403);
      await http().get('/v1/admin/materials').set(support.headers).expect(403);
      await http().get('/v1/admin/materials').set(teacher.headers).expect(200);
    });
  });
});
