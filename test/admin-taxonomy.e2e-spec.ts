import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { baseTaxonomy, makeQuestions } from './fixtures';
import { createApp, FakeClock, resetDb, signedInAdmin } from './helpers';

describe('admin: taxonomy and exam patterns', () => {
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
  const paper = { code: 'pre_gs', stage: 'prelims', nameEn: 'Paper I', nameHi: 'प्रश्नपत्र I', questionCount: 100, totalMarks: 200, durationMin: 120, correctMarks: 2, negativeFraction: 1 / 3 };
  const exam = { id: 'Demo', nameEn: 'Demo', nameHi: 'डेमो', shortEn: 'Demo', shortHi: 'डेमो' };

  it('only roles with the right permission can change patterns or taxonomy', async () => {
    const teacher = await signedInAdmin(app, prisma, clock, 'TEACHER');
    const editor = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
    const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
    expect((await http().post('/v1/admin/taxonomy/exams').set(teacher.headers).send(exam).expect(403)).body.error.details.required).toBe('exam-config:write');
    await http().post('/v1/admin/taxonomy/exams').set(editor.headers).send(exam).expect(403); // editors do not own exam rules
    await http().get('/v1/admin/taxonomy/tree').set(teacher.headers).expect(200);
    await http().post('/v1/admin/taxonomy/exams').set(admin.headers).send(exam).expect(201);
    await http().post('/v1/admin/taxonomy/subjects').set(editor.headers).send({ code: 'HIST', nameEn: 'History', nameHi: 'इतिहास' }).expect(201);
    await http().post('/v1/admin/taxonomy/subjects').set(teacher.headers).send({ code: 'GEO', nameEn: 'G', nameHi: 'G' }).expect(403);
  });

  it('exam patterns start unverified; verifying marks them; any later edit makes them unverified again', async () => {
    const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
    const created = await http().post('/v1/admin/taxonomy/exams').set(admin.headers).send(exam).expect(201);
    expect(created.body).toMatchObject({ id: 'demo', patternVerified: false });
    const p = await http().post('/v1/admin/taxonomy/exams/demo/papers').set(admin.headers).send(paper).expect(201);
    expect(p.body.paper).toMatchObject({ id: 'demo_pre_gs', code: 'PRE_GS' });
    expect(p.body.warnings).toEqual([]);

    const v = await http().post('/v1/admin/taxonomy/exams/demo/verify-pattern').set(admin.headers).send({ sourceUrl: 'https://psc.cg.gov.in/notice.pdf', note: 'Checked Oct 2026' }).expect(200);
    expect(v.body).toMatchObject({ patternVerified: true, patternSourceUrl: 'https://psc.cg.gov.in/notice.pdf' });

    const upd = await http().put('/v1/admin/taxonomy/papers/demo_pre_gs').set(admin.headers).send({ ...paper, totalMarks: 150 }).expect(200);
    expect(upd.body.warnings[0]).toContain('differ');
    expect((await prisma.exam.findUniqueOrThrow({ where: { id: 'demo' } })).patternVerified).toBe(false);
  });

  it('validates paper patterns (qualifying papers, negative fraction, units)', async () => {
    const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
    await http().post('/v1/admin/taxonomy/exams').set(admin.headers).send(exam).expect(201);
    const post = (body: object) => http().post('/v1/admin/taxonomy/exams/demo/papers').set(admin.headers).send({ ...paper, ...body });
    const qualifying = { code: 'CSAT', qualifyingPct: 33, qualifyingPctReserved: 23, countsTowardMerit: false };
    await post(qualifying).expect(201);
    expect((await post({ code: 'X1', qualifyingPct: 23, qualifyingPctReserved: 33, countsTowardMerit: false }).expect(400)).body.error.details[0].problems[0]).toContain('reserved cut-off cannot be higher');
    expect((await post({ code: 'X2', qualifyingPct: 33, countsTowardMerit: true }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    await post({ code: 'X3', negativeFraction: 2 }).expect(400);
    await post({ code: 'X4', questionCount: 0 }).expect(400);
    await post({ code: 'bad code!' }).expect(400);
    await post({ code: 'CSAT' }).expect(409); // duplicate
  });

  it('refuses to delete things that are in use and keeps referential integrity', async () => {
    await baseTaxonomy(prisma);
    await makeQuestions(prisma, 1);
    const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
    expect((await http().delete('/v1/admin/taxonomy/topics/T1').set(admin.headers).expect(409)).body.error.code).toBe('IN_USE');
    expect((await http().delete('/v1/admin/taxonomy/exams/cgpsc').set(admin.headers).expect(409)).body.error.code).toBe('IN_USE');
    await http().delete('/v1/admin/taxonomy/topics/T2').set(admin.headers).expect(204);
    await http().delete('/v1/admin/taxonomy/topics/T2').set(admin.headers).expect(404);
    await http().post('/v1/admin/taxonomy/topics').set(admin.headers).send({ code: 'NEW', subjectCode: 'NOPE', nameEn: 'n', nameHi: 'न' }).expect(409);
  });

  it('builds the subject → topic → subtopic hierarchy and maps subjects to a paper', async () => {
    await baseTaxonomy(prisma);
    const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
    await http().post('/v1/admin/taxonomy/subtopics').set(admin.headers).send({ code: 'T1_A', topicCode: 'T1', nameEn: 'Sub A', nameHi: 'उप' }).expect(201);
    await http().patch('/v1/admin/taxonomy/subtopics/T1_A').set(admin.headers).send({ nameEn: 'Sub A2' }).expect(200);
    await http().put('/v1/admin/taxonomy/papers/cgpsc_pre_gs/subjects').set(admin.headers).send({ subjectCodes: ['S1'] }).expect(204);
    await http().put('/v1/admin/taxonomy/papers/cgpsc_pre_gs/subjects').set(admin.headers).send({ subjectCodes: ['NOPE'] }).expect(400);
    const tree = (await http().get('/v1/admin/taxonomy/tree').set(admin.headers).expect(200)).body;
    expect(tree.subjects[0].topics[0].subtopics[0]).toMatchObject({ code: 'T1_A', nameEn: 'Sub A2' });
    expect(tree.exams[0].papers[0].subjects).toHaveLength(1);
  });

  it('writes an audit row (who, what, before/after) for every change', async () => {
    const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
    await http().post('/v1/admin/taxonomy/exams').set(admin.headers).send(exam).expect(201);
    await http().patch('/v1/admin/taxonomy/exams/demo').set(admin.headers).send({ nameEn: 'Renamed' }).expect(200);
    const rows = await prisma.auditLog.findMany({ where: { targetType: 'exam' }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual(['exam.created', 'exam.updated']);
    expect(rows[1]).toMatchObject({ actor: admin.id, actorType: 'admin', target: 'demo' });
    expect((rows[1].before as { nameEn: string }).nameEn).toBe('Demo');
    expect((rows[1].after as { nameEn: string }).nameEn).toBe('Renamed');
  });
});
