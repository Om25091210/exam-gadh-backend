import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { parseCsv, parseXlsx } from '../src/modules/import-export/question-sheet';
import { baseTaxonomy } from './fixtures';
import { createApp, FakeClock, resetDb, signedInAdmin } from './helpers';

const HEAD = 'code,type,topic,subtopic,difficulty,answer,en_stem,en_option_a,en_option_b,en_option_c,en_option_d,hi_stem,hi_option_a,hi_option_b,hi_option_c,hi_option_d,en_statements,passage_ref,passage_en';
const good = (code: string, stem: string) => `${code},single,T1,,2,B,${stem},a,b,c,d,,,,,,,,`;

describe('admin: bulk import and export', () => {
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
  const upload = (who: { headers: Record<string, string> }, csv: string | Buffer, name = 'q.csv', qs = '') =>
    http().post(`/v1/admin/import/questions/preview${qs}`).set(who.headers).attach('file', Buffer.isBuffer(csv) ? csv : Buffer.from(csv), name);

  it('serves the template as CSV and XLSX, readable by our own parser', async () => {
    const ed = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
    const csv = await http().get('/v1/admin/import/questions/template').set(ed.headers).expect(200);
    expect(csv.headers['content-disposition']).toContain('questions-template.csv');
    expect(parseCsv(Buffer.from(csv.text))).toHaveLength(2);
    const x = await http().get('/v1/admin/import/questions/template?format=xlsx').set(ed.headers).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(await parseXlsx(x.body as Buffer)).toHaveLength(2);
  });

  it('only roles with import:run can use it', async () => {
    const teacher = await signedInAdmin(app, prisma, clock, 'TEACHER');
    await http().get('/v1/admin/import/questions/template').set(teacher.headers).expect(403);
    await upload(teacher, `${HEAD}\n${good('A', 'Q')}`).expect(403);
  });

  it('dry run reports every bad row with its row number and column, and writes nothing', async () => {
    const ed = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
    const csv = [HEAD, good('OK-1', 'First good question'), `BAD-1,single,NOPE,,2,B,Unknown topic,a,b,c,d,,,,,,,,`, `BAD-2,single,T1,,2,Z,Bad answer,a,b,c,d,,,,,,,,`, `BAD-3,single,T1,,2,B,Missing option,a,b,c,,,,,,,,,`, good('OK-2', 'Second good question')].join('\n');
    const r = await upload(ed, csv).expect(200);
    expect(r.body).toMatchObject({ status: 'dry_run', rowsTotal: 5, rowsOk: 2, rowsFailed: 3, willCreate: 2, willUpdate: 0 });
    expect(r.body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 3, field: 'topic', message: expect.stringContaining('unknown topic') }),
      expect.objectContaining({ row: 4, field: 'answer' }),
      expect.objectContaining({ row: 5, field: 'en_option_d' }),
    ]));
    expect(await prisma.question.count()).toBe(0); // dry run changes nothing
  });

  it('commit is all-or-nothing and refuses a file with errors unless the valid rows are chosen explicitly', async () => {
    const ed = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
    const csv = [HEAD, good('OK-1', 'First good question'), `BAD-2,single,T1,,2,Z,Bad answer,a,b,c,d,,,,,,,,`].join('\n');
    const job = (await upload(ed, csv).expect(200)).body;
    const blocked = await http().post(`/v1/admin/import/jobs/${job.jobId}/commit`).set(ed.headers).send({}).expect(409);
    expect(blocked.body.error).toMatchObject({ code: 'HAS_ERRORS', details: { rowsFailed: 1 } });
    expect(await prisma.question.count()).toBe(0);
    const ok = await http().post(`/v1/admin/import/jobs/${job.jobId}/commit`).set(ed.headers).send({ skipInvalid: true }).expect(200);
    expect(ok.body).toMatchObject({ created: 1, updated: 0, skippedRows: 1 });
    expect(await prisma.question.findMany()).toMatchObject([{ code: 'OK-1', status: 'draft', version: 1 }]);
    expect(await prisma.questionVersion.count()).toBe(1);
    // a second commit of the same job is refused
    expect((await http().post(`/v1/admin/import/jobs/${job.jobId}/commit`).set(ed.headers).send({ skipInvalid: true }).expect(409)).body.error.code).toBe('ALREADY_COMMITTED');
    expect(await prisma.question.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'import.committed' } })).toBe(1);
  });

  it('commits two clicks at once exactly once', async () => {
    const ed = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
    const job = (await upload(ed, [HEAD, good('P-1', 'Parallel one'), good('P-2', 'Parallel two')].join('\n')).expect(200)).body;
    const res = await Promise.all([1, 2, 3].map(() => http().post(`/v1/admin/import/jobs/${job.jobId}/commit`).set(ed.headers).send({})));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await prisma.question.count()).toBe(2);
  });

  it("one admin cannot commit or read another admin's preview", async () => {
    const a = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR', 'a@examgadh.test');
    const b = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR', 'b@examgadh.test');
    const job = (await upload(a, [HEAD, good('X-1', 'Only mine')].join('\n')).expect(200)).body;
    await http().post(`/v1/admin/import/jobs/${job.jobId}/commit`).set(b.headers).send({}).expect(404);
    await http().get(`/v1/admin/import/jobs/${job.jobId}`).set(b.headers).expect(404);
    expect((await http().get('/v1/admin/import/jobs').set(b.headers).expect(200)).body).toHaveLength(0);
    expect((await http().get(`/v1/admin/import/jobs/${job.jobId}`).set(a.headers).expect(200)).body.status).toBe('dry_run');
  });

  it('finds duplicates inside the file and against the bank, and updates by code create a new version', async () => {
    const ed = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
    await http().post('/v1/admin/import/jobs/00000000-0000-4000-8000-000000000000/commit').set(ed.headers).send({}).expect(404);
    const first = (await upload(ed, [HEAD, good('U-1', 'Original wording')].join('\n')).expect(200)).body;
    await http().post(`/v1/admin/import/jobs/${first.jobId}/commit`).set(ed.headers).send({}).expect(200);

    const csv = [HEAD, good('U-1', 'Reworded question'), good('N-1', 'Fresh'), good('N-2', 'fresh'), good('N-3', 'Original wording')].join('\n');
    const r = (await upload(ed, csv).expect(200)).body;
    expect(r).toMatchObject({ willCreate: 1, willUpdate: 1, rowsFailed: 2 });
    // row 2 = U-1 (update), 3 = N-1, 4 = N-2 (same text as row 3), 5 = N-3 (text already in the bank)
    expect(r.errors.map((e: { row: number }) => e.row)).toEqual([4, 5]);
    expect(r.errors[0].message).toContain('same question as row 3');
    expect(r.errors[1].message).toContain('already has this question');
    await http().post(`/v1/admin/import/jobs/${r.jobId}/commit`).set(ed.headers).send({ skipInvalid: true }).expect(200);
    const u1 = await prisma.question.findUniqueOrThrow({ where: { code: 'U-1' } });
    expect(u1.version).toBe(2);
    expect(await prisma.questionVersion.count({ where: { questionId: u1.id } })).toBe(2);
    expect((await upload(ed, [HEAD, good('D-1', 'Original wording')].join('\n'), 'q.csv', '?allowDuplicates=true').expect(200)).body.rowsFailed).toBe(0);
  });

  it('a published question changed by import goes back to review', async () => {
    const ed = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
    const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
    const j = (await upload(ed, [HEAD, good('PUB-1', 'Will be live')].join('\n')).expect(200)).body;
    await http().post(`/v1/admin/import/jobs/${j.jobId}/commit`).set(ed.headers).send({}).expect(200);
    const q = await prisma.question.findUniqueOrThrow({ where: { code: 'PUB-1' } });
    await http().post(`/v1/admin/questions/${q.id}/status`).set(admin.headers).send({ to: 'published' }).expect(200);
    const j2 = (await upload(ed, [HEAD, good('PUB-1', 'Changed while live')].join('\n')).expect(200)).body;
    await http().post(`/v1/admin/import/jobs/${j2.jobId}/commit`).set(ed.headers).send({}).expect(200);
    expect((await prisma.question.findUniqueOrThrow({ where: { code: 'PUB-1' } })).status).toBe('in_review');
  });

  it('shares one passage between rows with the same passage_ref', async () => {
    const ed = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
    const pr = (code: string, stem: string, text: string) => `${code},passage,T1,,2,A,${stem},a,b,c,d,,,,,,,P1,${text}`;
    const csv = [HEAD, pr('PS-1', 'First about it', 'The shared passage text.'), pr('PS-2', 'Second about it', ''), pr('PS-3', 'Third about it', '')].join('\n');
    const r = (await upload(ed, csv).expect(200)).body;
    expect(r.rowsFailed).toBe(0);
    await http().post(`/v1/admin/import/jobs/${r.jobId}/commit`).set(ed.headers).send({}).expect(200);
    expect(await prisma.passage.count()).toBe(1);
    expect(await prisma.question.count({ where: { passageId: { not: null } } })).toBe(3);
    const missing = (await upload(ed, [HEAD, pr('PS-9', 'No text anywhere', '').replace('P1', 'P9')].join('\n')).expect(200)).body;
    expect(missing.errors[0]).toMatchObject({ field: 'passage_ref' });
  });

  it('rejects unreadable, empty, mis-typed and incomplete files', async () => {
    const ed = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
    expect((await upload(ed, 'topic\nT1\n', 'q.csv').expect(400)).body.error.code).toBe('MISSING_COLUMNS');
    expect((await upload(ed, 'topic\n', 'q.csv').expect(400)).body.error.code).toBe('EMPTY_FILE');
    expect((await upload(ed, `${HEAD}\n`, 'q.csv').expect(400)).body.error.code).toBe('EMPTY_FILE');
    expect((await upload(ed, 'whatever', 'q.pdf').expect(400)).body.error.code).toBe('UNREADABLE_FILE');
    expect((await upload(ed, Buffer.from([0x50, 0x4b, 9, 9]), 'q.xlsx').expect(400)).body.error.code).toBe('UNREADABLE_FILE');
    expect((await http().post('/v1/admin/import/questions/preview').set(ed.headers).send({}).expect(400)).body.error.code).toBe('FILE_REQUIRED');
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 'a');
    expect((await upload(ed, big, 'big.csv')).status).toBeGreaterThanOrEqual(400);
    const tooMany = [HEAD, ...Array.from({ length: 5001 }, (_, i) => good(`R-${i}`, `Question number ${i}`))].join('\n');
    expect((await upload(ed, tooMany).expect(400)).body.error.code).toBe('TOO_MANY_ROWS');
  });

  it('exports in the template layout, filtered, and an export re-imports as updates', async () => {
    const ed = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
    const j = (await upload(ed, [HEAD, good('E-1', 'Export one'), `E-2,single,T2,,3,C,"Export, two",a,b,c,d,हिंदी,अ,ब,स,द,,,`].join('\n')).expect(200)).body;
    await http().post(`/v1/admin/import/jobs/${j.jobId}/commit`).set(ed.headers).send({}).expect(200);
    const all = await http().get('/v1/admin/export/questions').set(ed.headers).expect(200);
    expect(all.headers['content-disposition']).toContain('questions.csv');
    expect(all.text.startsWith('﻿code,type,topic')).toBe(true);
    const rows = parseCsv(Buffer.from(all.text));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.code === 'E-2')).toMatchObject({ en_stem: 'Export, two', hi_stem: 'हिंदी', answer: 'C', difficulty: '3' });
    expect(parseCsv(Buffer.from((await http().get('/v1/admin/export/questions?topicCode=T2').set(ed.headers).expect(200)).text))).toHaveLength(1);
    const again = (await upload(ed, all.text, 'export.csv').expect(200)).body;
    expect(again).toMatchObject({ rowsFailed: 0, willUpdate: 2, willCreate: 0 });
    const support = await signedInAdmin(app, prisma, clock, 'SUPPORT');
    await http().get('/v1/admin/export/questions').set(support.headers).expect(403);
  });
});
