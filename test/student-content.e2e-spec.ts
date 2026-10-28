import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { istDateString } from '../src/common/ist';
import { baseTaxonomy, makeQuestions, makeTest } from './fixtures';
import { bearer, createApp, FakeClock, login, resetDb, signedInAdmin } from './helpers';

describe('student: learning content', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clock: FakeClock;
  beforeAll(async () => ({ app, prisma, clock } = await createApp()));
  afterAll(() => app.close());
  beforeEach(async () => {
    clock.reset();
    await resetDb(prisma);
    await baseTaxonomy(prisma);
    await prisma.plan.create({ data: { id: 'pass', nameEn: 'Pass', nameHi: 'पास', prices: { '3': 1 } } });
  });
  const http = () => request(app.getHttpServer());
  async function student(sub = 'stu', paid = false) {
    const r = await login(app, sub);
    if (paid) await prisma.entitlement.create({ data: { userId: r.body.user.id, planId: 'pass', endsAt: new Date(Date.now() + 864e5), source: 'admin' } });
    return { h: bearer(r.body.accessToken), id: r.body.user.id as string };
  }
  const ca = (o: object = {}) => prisma.currentAffair.create({ data: { date: new Date('2026-10-27'), category: 'CG', titleEn: 'Title', titleHi: 'शीर्षक', summaryEn: 'Summary', summaryHi: 'सारांश', status: 'published', angleEn: 'Exam angle', ...o } });

  it('every learning route needs a signed-in student', async () => {
    for (const path of ['/v1/ca', '/v1/ca/monthly?month=2026-10', '/v1/updates', '/v1/faqs', '/v1/interview', '/v1/materials', '/v1/pyq', '/v1/pyq/frequency', '/v1/series', '/v1/daily-quiz']) {
      expect((await http().get(path)).status).toBe(401);
    }
  });

  describe('current affairs', () => {
    it('shows only published items that are not scheduled for later; filters by day, category, topic, text and range', async () => {
      const s = await student();
      await ca({ titleEn: 'Budget', category: 'CG', topicCode: 'T1' });
      await ca({ titleEn: 'Parliament', category: 'NAT', date: new Date('2026-10-26'), titleHi: 'संसद' });
      await ca({ titleEn: 'Draft one', status: 'draft' });
      await ca({ titleEn: 'Later', publishAt: new Date(Date.now() + 3_600_000) });
      await ca({ titleEn: 'Archived', status: 'archived' });
      const get = (qs: string) => http().get(`/v1/ca?${qs}`).set(s.h).expect(200).then((r) => r.body);
      const all = await get('');
      expect(all.items.map((i: { titleEn: string }) => i.titleEn)).toEqual(['Budget', 'Parliament']);
      expect((await get('category=NAT')).items).toHaveLength(1);
      expect((await get('topic=T1')).items[0].titleEn).toBe('Budget');
      expect((await get('date=2026-10-26')).items[0].titleEn).toBe('Parliament');
      expect((await get('from=2026-10-27&to=2026-10-27')).total).toBe(1);
      expect((await get('q=संसद')).total).toBe(1);
      await http().get('/v1/ca?date=27-10-2026').set(s.h).expect(400);
      await http().get('/v1/ca?pageSize=999').set(s.h).expect(400);
    });

    it('a paid item shows only its headline to free students; detail includes the exam angle for those who can read it', async () => {
      const free = await student('free');
      const paid = await student('paid', true);
      const item = await ca({ titleEn: 'Premium analysis', access: 'paid', summaryEn: 'Secret summary' });
      const l = (await http().get('/v1/ca').set(free.h).expect(200)).body.items[0];
      expect(l).toMatchObject({ locked: true, titleEn: 'Premium analysis' });
      expect(JSON.stringify(l)).not.toContain('Secret summary');
      expect(JSON.stringify((await http().get(`/v1/ca/${item.id}`).set(free.h).expect(200)).body)).not.toContain('Secret summary');
      const d = (await http().get(`/v1/ca/${item.id}`).set(paid.h).expect(200)).body;
      expect(d).toMatchObject({ locked: false, summaryEn: 'Secret summary', angleEn: 'Exam angle' });
      const draft = await ca({ status: 'draft' });
      await http().get(`/v1/ca/${draft.id}`).set(paid.h).expect(404);
      await http().get('/v1/ca/not-a-uuid').set(paid.h).expect(400);
    });

    it('builds the monthly compilation grouped by day', async () => {
      const s = await student();
      await ca({ titleEn: 'A', date: new Date('2026-10-02') });
      await ca({ titleEn: 'B', date: new Date('2026-10-02'), category: 'NAT' });
      await ca({ titleEn: 'C', date: new Date('2026-10-15') });
      await ca({ titleEn: 'Other month', date: new Date('2026-11-01') });
      const m = (await http().get('/v1/ca/monthly?month=2026-10').set(s.h).expect(200)).body;
      expect(m.total).toBe(3);
      expect(m.days.map((d: { date: string; items: unknown[] }) => [d.date, d.items.length])).toEqual([['2026-10-02', 2], ['2026-10-15', 1]]);
      await http().get('/v1/ca/monthly?month=2026-13').set(s.h).expect(400);
    });
  });

  describe('updates, calendar, FAQs, interview', () => {
    it('shows live announcements (pinned first), hides draft/scheduled/expired, and only upcoming calendar dates', async () => {
      const s = await student();
      const mk = (o: object) => prisma.announcement.create({ data: { titleEn: 'T', titleHi: 'श', bodyEn: 'B', bodyHi: 'ब', status: 'published', ...o } });
      await mk({ titleEn: 'Normal' });
      await mk({ titleEn: 'Pinned', pinned: true });
      await mk({ titleEn: 'Draft', status: 'draft' });
      await mk({ titleEn: 'Scheduled', publishAt: new Date(Date.now() + 3_600_000) });
      await mk({ titleEn: 'Expired', expiresAt: new Date(Date.now() - 1000) });
      await mk({ titleEn: 'SI only', examId: 'si' });
      await prisma.exam.create({ data: { id: 'si', nameEn: 'SI', nameHi: 'SI', shortEn: 'SI', shortHi: 'SI' } });
      const today = istDateString(new Date());
      await prisma.calendarEvent.create({ data: { examId: 'cgpsc', labelEn: 'Upcoming prelims', labelHi: 'आगामी', date: new Date(new Date(`${today}T00:00:00Z`).getTime() + 30 * 864e5) } });
      await prisma.calendarEvent.create({ data: { examId: 'cgpsc', labelEn: 'Old event', labelHi: 'पुराना', date: new Date(new Date(`${today}T00:00:00Z`).getTime() - 30 * 864e5) } });
      const u = (await http().get('/v1/updates').set(s.h).expect(200)).body;
      expect(u.announcements.map((a: { titleEn: string }) => a.titleEn)).toEqual(['Pinned', 'Normal']);
      expect(u.calendar.map((c: { labelEn: string }) => c.labelEn)).toEqual(['Upcoming prelims']);
      expect((await http().get('/v1/updates?examId=si').set(s.h).expect(200)).body.announcements.map((a: { titleEn: string }) => a.titleEn)).toContain('SI only');
    });

    it('searches FAQs by keywords or question text (either language) and lists interview questions by exam/category', async () => {
      const s = await student();
      await prisma.faq.create({ data: { keywords: 'negative marking minus', qEn: 'Is there negative marking?', qHi: 'क्या ऋणात्मक अंकन है?', aEn: 'Yes', aHi: 'हाँ' } });
      await prisma.faq.create({ data: { keywords: 'refund', qEn: 'Can I get a refund?', qHi: 'क्या रिफंड मिलेगा?', aEn: 'Within 7 days', aHi: '7 दिन में' } });
      expect((await http().get('/v1/faqs?q=minus').set(s.h).expect(200)).body).toHaveLength(1);
      expect((await http().get('/v1/faqs?q=रिफंड').set(s.h).expect(200)).body).toHaveLength(1);
      expect((await http().get('/v1/faqs').set(s.h).expect(200)).body).toHaveLength(2);
      await prisma.interviewQuestion.create({ data: { examId: 'cgpsc', category: 'personal', qEn: 'Why?', qHi: 'क्यों?', pointsEn: 'p', pointsHi: 'प' } });
      await prisma.interviewQuestion.create({ data: { examId: 'cgpsc', category: 'current', qEn: 'News?', qHi: 'खबर?', pointsEn: 'p', pointsHi: 'प' } });
      expect((await http().get('/v1/interview?examId=cgpsc').set(s.h).expect(200)).body).toHaveLength(2);
      expect((await http().get('/v1/interview?category=personal').set(s.h).expect(200)).body).toHaveLength(1);
    });
  });

  describe('study material', () => {
    it('lists live items, locks paid ones, and hands out private PDF links only to those allowed', async () => {
      const free = await student('free');
      const paid = await student('paid', true);
      const mk = (o: object) => prisma.material.create({ data: { titleEn: 'M', titleHi: 'म', kind: 'link', url: 'https://example.com/x', status: 'published', ...o } });
      const link = await mk({ titleEn: 'Free link' });
      const pdf = await mk({ titleEn: 'Paid PDF', kind: 'pdf', fileKey: 'materials/abc.pdf', url: null, access: 'paid' });
      await mk({ titleEn: 'Draft', status: 'draft' });
      await mk({ titleEn: 'Later', publishAt: new Date(Date.now() + 3_600_000) });
      const list = (await http().get('/v1/materials').set(free.h).expect(200)).body;
      expect(list.items.map((i: { titleEn: string; locked: boolean }) => [i.titleEn, i.locked]).sort()).toEqual([['Free link', false], ['Paid PDF', true]]);
      expect((await http().get(`/v1/materials/${link.id}`).set(free.h).expect(200)).body).toMatchObject({ url: 'https://example.com/x', downloadUrl: null });
      expect((await http().get(`/v1/materials/${pdf.id}`).set(free.h).expect(403)).body.error.code).toBe('PAYMENT_REQUIRED');
      const ok = (await http().get(`/v1/materials/${pdf.id}`).set(paid.h).expect(200)).body;
      const u = new URL(ok.downloadUrl);
      expect(u.hostname).toContain('examgadh-test-media');
      expect(u.pathname).toBe('/materials/abc.pdf');
      expect(u.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy();
      expect(decodeURIComponent(u.search)).toContain('attachment; filename="Paid_PDF.pdf"');
      expect(ok.downloadUrl).not.toContain('AKIAREAL');
      expect((await http().get('/v1/materials?kind=pdf').set(free.h).expect(200)).body.total).toBe(1);
    });
  });

  describe('uploads (admin) are pinned to one type and a size limit', () => {
    it('returns a signed form whose policy fixes the content type and size, with a server-chosen key', async () => {
      const editor = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
      const r = (await http().post('/v1/admin/uploads/presign').set(editor.headers).send({ purpose: 'question-image', contentType: 'image/png' }).expect(200)).body;
      expect(r.key).toMatch(/^public\/question-images\/[0-9a-f-]{36}\.png$/);
      expect(r.url).toContain('examgadh-test-media');
      const policy = JSON.parse(Buffer.from(r.fields.Policy, 'base64').toString());
      expect(policy.conditions).toEqual(expect.arrayContaining([['content-length-range', 1, 1024 * 1024], ['eq', '$Content-Type', 'image/png']]));
      expect(new Date(policy.expiration).getTime()).toBeLessThan(Date.now() + 6 * 60_000);
      const pdf = (await http().post('/v1/admin/uploads/presign').set(editor.headers).send({ purpose: 'material-pdf', contentType: 'application/pdf' }).expect(200)).body;
      expect(pdf.key).toMatch(/^materials\/[0-9a-f-]{36}\.pdf$/);
      expect((await http().post('/v1/admin/uploads/presign').set(editor.headers).send({ purpose: 'question-image', contentType: 'image/svg+xml' }).expect(400)).body.error.code).toBe('UNSUPPORTED_TYPE');
      expect((await http().post('/v1/admin/uploads/presign').set(editor.headers).send({ purpose: 'material-pdf', contentType: 'image/png' }).expect(400)).body.error.code).toBe('UNSUPPORTED_TYPE');
      await http().post('/v1/admin/uploads/presign').set(editor.headers).send({ purpose: 'doubt-audio', contentType: 'audio/webm' }).expect(400); // not an admin purpose
      const teacher = await signedInAdmin(app, prisma, clock, 'TEACHER');
      await http().post('/v1/admin/uploads/presign').set(teacher.headers).send({ purpose: 'question-image', contentType: 'image/png' }).expect(403);
    });
  });

  describe('previous-year papers', () => {
    it('groups papers by year and counts PYQ questions per topic', async () => {
      const s = await student();
      await makeTest(prisma, { kind: 'pyq', pyqYear: 2024, title: 'CGPSC 2024' });
      await makeTest(prisma, { kind: 'pyq', pyqYear: 2024, title: 'CGPSC 2024 CSAT' });
      await makeTest(prisma, { kind: 'pyq', pyqYear: 2023, title: 'CGPSC 2023' });
      await makeTest(prisma, { title: 'Not a PYQ' });
      const r = (await http().get('/v1/pyq').set(s.h).expect(200)).body;
      expect(r.years.map((y: { year: number; papers: unknown[] }) => [y.year, y.papers.length])).toEqual([[2024, 2], [2023, 1]]);
      expect((await http().get('/v1/pyq?year=2023').set(s.h).expect(200)).body.years).toHaveLength(1);
      const qs = await makeQuestions(prisma, 4, 'PY');
      for (const [i, q] of qs.entries()) await prisma.question.update({ where: { id: q }, data: { source: 'pyq', pyqYear: 2022, pyqExamId: 'cgpsc', topicCode: i < 3 ? 'T1' : 'T2' } });
      const f = (await http().get('/v1/pyq/frequency?examId=cgpsc').set(s.h).expect(200)).body;
      expect(f.total).toBe(4);
      expect(f.topics[0]).toMatchObject({ topicCode: 'T1', questions: 3, sharePct: 75 });
    });
  });

  describe('series and enrolment', () => {
    it('enrols in free series, requires a plan for paid ones, shows progress, and can leave', async () => {
      const free = await student('free');
      const paid = await student('paid', true);
      const t1 = await makeTest(prisma, { title: 'One' });
      const t2 = await makeTest(prisma, { title: 'Two' });
      const mk = (access: 'free' | 'paid', title: string) => prisma.testSeries.create({ data: { examId: 'cgpsc', titleEn: title, titleHi: title, access, status: 'published', items: { create: [{ testId: t1.testId, position: 0 }, { testId: t2.testId, position: 1 }] } } });
      const freeSeries = await mk('free', 'Free series');
      const paidSeries = await mk('paid', 'Paid series');
      await prisma.testSeries.create({ data: { examId: 'cgpsc', titleEn: 'Hidden draft', titleHi: 'x', status: 'draft' } });
      const list = (await http().get('/v1/series').set(free.h).expect(200)).body;
      expect(list.map((s: { titleEn: string; locked: boolean }) => [s.titleEn, s.locked]).sort()).toEqual([['Free series', false], ['Paid series', true]]);
      await http().post(`/v1/series/${freeSeries.id}/enroll`).set(free.h).expect(201);
      expect((await http().post(`/v1/series/${freeSeries.id}/enroll`).set(free.h).expect(409)).body.error.code).toBe('ALREADY_ENROLLED');
      expect((await http().post(`/v1/series/${paidSeries.id}/enroll`).set(free.h).expect(403)).body.error.code).toBe('PAYMENT_REQUIRED');
      await http().post(`/v1/series/${paidSeries.id}/enroll`).set(paid.h).expect(201);
      // progress follows real attempts
      const a = (await http().post(`/v1/tests/${t1.testId}/attempts`).set(free.h).expect(200)).body;
      await http().post(`/v1/attempts/${a.attemptId}/submit`).set(free.h).send({ submitKey: 'k' }).expect(200);
      const d = (await http().get(`/v1/series/${freeSeries.id}`).set(free.h).expect(200)).body;
      expect(d).toMatchObject({ enrolled: true, progress: { total: 2, attempted: 1 } });
      expect(d.tests.map((t: { titleEn: string; bestPct: number | null }) => [t.titleEn, t.bestPct])).toEqual([['One', 0], ['Two', null]]);
      await http().delete(`/v1/series/${freeSeries.id}/enroll`).set(free.h).expect(204);
      await http().delete(`/v1/series/${freeSeries.id}/enroll`).set(free.h).expect(404);
    });
  });

  describe('daily quiz', () => {
    it("shows today's quiz (IST day), then marks it done after an attempt", async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const s = await student();
      expect((await http().get('/v1/daily-quiz').set(s.h).expect(200)).body.available).toBe(false);
      const t = await makeTest(prisma, { n: 3, title: 'Daily 10', kind: 'mock' });
      const today = istDateString(clock.now());
      await http().put(`/v1/admin/daily-quiz/${today}`).set(admin.headers).send({ testId: t.testId }).expect(200);
      await http().put('/v1/admin/daily-quiz/2026-13-45').set(admin.headers).send({ testId: t.testId }).expect(400);
      await http().put(`/v1/admin/daily-quiz/${today}`).set(admin.headers).send({ testId: '00000000-0000-4000-8000-000000000000' }).expect(404);
      const q = (await http().get('/v1/daily-quiz').set(s.h).expect(200)).body;
      expect(q).toMatchObject({ available: true, done: false, test: { titleEn: 'Daily 10', questionCount: 3 } });
      const a = (await http().post(`/v1/tests/${t.testId}/attempts`).set(s.h).expect(200)).body;
      await http().post(`/v1/attempts/${a.attemptId}/submit`).set(s.h).send({ submitKey: 'k' }).expect(200);
      expect((await http().get('/v1/daily-quiz').set(s.h).expect(200)).body).toMatchObject({ done: true });
    });
  });
});
