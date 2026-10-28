import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiError, badRequest, conflict, notFound } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminPrincipal } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { PreparedQuestion } from '../questions/question-input';
import { QuestionsRepository } from '../questions/questions.repository';
import { COLUMNS, mapRow, MAX_ROWS, parseQuestionFile, questionToRow, RowIssue, TEMPLATE_ROWS, writeCsv, writeXlsx } from './question-sheet';

type Actor = { admin: AdminPrincipal; ip?: string };

interface StoredRow {
  row: number;
  action: 'create' | 'update';
  existingId?: string;
  prepared: PreparedQuestion;
  passageRef?: string;
}

const SAMPLE = 25;

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: QuestionsRepository,
    private readonly audit: AuditService,
  ) {}

  async template(format: 'csv' | 'xlsx') {
    return format === 'xlsx' ? { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'questions-template.xlsx', data: await writeXlsx(TEMPLATE_ROWS) } : { type: 'text/csv; charset=utf-8', name: 'questions-template.csv', data: writeCsv(TEMPLATE_ROWS) };
  }

  /** Dry run: parse, validate every row, detect duplicates; nothing is written to the question bank. */
  async preview(a: Actor, file: { originalname: string; buffer: Buffer }, allowDuplicates: boolean) {
    let rows;
    try {
      rows = await parseQuestionFile(file.buffer, file.originalname);
    } catch (e) {
      throw badRequest('UNREADABLE_FILE', e instanceof Error ? e.message : 'The file could not be read');
    }
    if (rows.length === 0) throw badRequest('EMPTY_FILE', 'The file has no data rows');
    if (rows.length > MAX_ROWS) throw badRequest('TOO_MANY_ROWS', `At most ${MAX_ROWS} rows per file (this file has ${rows.length})`);
    const headers = new Set(Object.keys(rows[0]));
    const required = ['topic', 'answer'];
    const missing = required.filter((h) => !headers.has(h));
    if (missing.length) throw badRequest('MISSING_COLUMNS', `Missing column(s): ${missing.join(', ')}. Download the template for the expected layout.`);
    const unknown = [...headers].filter((h) => !(COLUMNS as readonly string[]).includes(h));

    const [topics, subtopics] = await Promise.all([this.prisma.topic.findMany({ select: { code: true } }), this.prisma.subtopic.findMany({ select: { code: true, topicCode: true } })]);
    const topicSet = new Set(topics.map((t) => t.code));
    const subMap = new Map(subtopics.map((s) => [s.code, s.topicCode]));
    const codes = rows.map((r) => r.code?.trim()).filter(Boolean) as string[];
    const existingByCode = new Map((await this.prisma.question.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })).map((q) => [q.code!, q.id]));

    const issues: RowIssue[] = [];
    const valid: StoredRow[] = [];
    const seenHash = new Map<string, number>();
    const seenCode = new Map<string, number>();
    const passages = new Map<string, { en?: string; hi?: string }>();

    for (const [i, raw] of rows.entries()) {
      const rowNo = i + 2; // spreadsheet row (row 1 is the header)
      const m = mapRow(raw, rowNo);
      const rowIssues = [...m.issues];
      const p = m.prepared;
      if (p) {
        if (!topicSet.has(p.data.topicCode)) rowIssues.push({ row: rowNo, field: 'topic', message: `unknown topic ${p.data.topicCode}` });
        if (p.data.subtopicCode && subMap.get(p.data.subtopicCode) !== p.data.topicCode) rowIssues.push({ row: rowNo, field: 'subtopic', message: `subtopic ${p.data.subtopicCode} does not belong to topic ${p.data.topicCode}` });
        if (p.data.code) {
          const dupCode = seenCode.get(p.data.code);
          if (dupCode) rowIssues.push({ row: rowNo, field: 'code', message: `code ${p.data.code} is repeated (first on row ${dupCode})` });
          seenCode.set(p.data.code, rowNo);
        }
        const first = seenHash.get(p.data.contentHash);
        if (first && !allowDuplicates) rowIssues.push({ row: rowNo, field: 'en_stem', message: `same question as row ${first} in this file` });
        seenHash.set(p.data.contentHash, first ?? rowNo);
        if (m.passageRef) {
          const known = passages.get(m.passageRef);
          if (p.passage && (p.passage.en !== '(shared passage)')) passages.set(m.passageRef, p.passage);
          else if (!known) rowIssues.push({ row: rowNo, field: 'passage_ref', message: `passage_ref ${m.passageRef} has no passage text on any earlier row` });
        }
      }
      if (rowIssues.length || !p) {
        issues.push(...rowIssues);
        continue;
      }
      valid.push({ row: rowNo, action: p.data.code && existingByCode.has(p.data.code) ? 'update' : 'create', existingId: p.data.code ? existingByCode.get(p.data.code) : undefined, prepared: { ...p, passage: m.passageRef ? passages.get(m.passageRef) : undefined }, passageRef: m.passageRef });
    }

    // Against the bank: a new question whose text already exists is a duplicate (updates keep their own text)
    if (!allowDuplicates) {
      const hashes = valid.map((v) => v.prepared.data.contentHash);
      const inBank = await this.prisma.question.findMany({ where: { contentHash: { in: hashes } }, select: { id: true, code: true, contentHash: true } });
      const byHash = new Map<string, typeof inBank>();
      for (const q of inBank) byHash.set(q.contentHash, [...(byHash.get(q.contentHash) ?? []), q]);
      for (let i = valid.length - 1; i >= 0; i--) {
        const v = valid[i];
        const clash = (byHash.get(v.prepared.data.contentHash) ?? []).find((q) => q.id !== v.existingId);
        if (clash) {
          issues.push({ row: v.row, field: 'en_stem', message: `the question bank already has this question (${clash.code ?? clash.id})` });
          valid.splice(i, 1);
        }
      }
    }
    issues.sort((x, y) => x.row - y.row);
    const failedRows = new Set(issues.map((i) => i.row)).size;
    const job = await this.prisma.importJob.create({
      data: { adminId: a.admin.id, kind: 'questions', fileName: file.originalname.slice(0, 200), status: 'dry_run', rowsTotal: rows.length, rowsOk: valid.length, rowsFailed: failedRows, errors: issues as unknown as Prisma.InputJsonValue, rows: valid as unknown as Prisma.InputJsonValue },
    });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'import.previewed', targetType: 'import', target: job.id, meta: { fileName: file.originalname, rows: rows.length, ok: valid.length, failed: failedRows }, ip: a.ip });
    return {
      jobId: job.id,
      status: job.status,
      rowsTotal: rows.length,
      rowsOk: valid.length,
      rowsFailed: failedRows,
      willCreate: valid.filter((v) => v.action === 'create').length,
      willUpdate: valid.filter((v) => v.action === 'update').length,
      ignoredColumns: unknown,
      errors: issues.slice(0, 200),
      errorsTruncated: issues.length > 200,
      sample: valid.slice(0, SAMPLE).map((v) => ({ row: v.row, action: v.action, code: v.prepared.data.code ?? null, type: v.prepared.data.type, topic: v.prepared.data.topicCode, languages: [v.prepared.data.hasEn && 'en', v.prepared.data.hasHi && 'hi'].filter(Boolean) })),
    };
  }

  /** Writes the validated rows in ONE transaction: all of them or none. Needs a clean file unless skipInvalid is set. */
  async commit(a: Actor, jobId: string, skipInvalid: boolean) {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job || job.adminId !== a.admin.id) throw notFound('Import job'); // an admin can only commit their own preview
    if (job.status !== 'dry_run') throw conflict('ALREADY_COMMITTED', `This import is already ${job.status}`);
    if (job.rowsFailed > 0 && !skipInvalid) throw conflict('HAS_ERRORS', `${job.rowsFailed} row(s) have errors. Fix the file, or commit only the valid rows with skipInvalid=true`, { rowsFailed: job.rowsFailed });
    const rows = job.rows as unknown as StoredRow[];
    if (rows.length === 0) throw conflict('NOTHING_TO_IMPORT', 'There are no valid rows to import');

    // Claim the job first: a double click or two tabs cannot import the same file twice.
    const claimed = await this.prisma.importJob.updateMany({ where: { id: jobId, status: 'dry_run' }, data: { status: 'committing' } });
    if (claimed.count !== 1) throw conflict('ALREADY_COMMITTED', 'This import is already running or finished');
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const passageIds = new Map<string, string>();
        let created = 0;
        let updated = 0;
        for (const r of rows) {
          const d = r.prepared.data;
          let passageId: string | null = null;
          if (d.type === 'passage' && r.passageRef) {
            if (!passageIds.has(r.passageRef)) passageIds.set(r.passageRef, (await tx.passage.create({ data: { body: (r.prepared.passage ?? {}) as Prisma.InputJsonValue } })).id);
            passageId = passageIds.get(r.passageRef)!;
          }
          const body = d.body as unknown as Prisma.InputJsonValue;
          if (r.action === 'update' && r.existingId) {
            const before = await tx.question.findUniqueOrThrow({ where: { id: r.existingId } });
            const changed = before.contentHash !== d.contentHash || before.answer !== d.answer || JSON.stringify(before.body) !== JSON.stringify(d.body);
            const q = await tx.question.update({ where: { id: r.existingId }, data: { ...d, body, passageId, ...(changed ? { version: { increment: 1 }, status: before.status === 'published' ? 'in_review' : before.status } : {}) } });
            if (changed) await tx.questionVersion.create({ data: { questionId: q.id, version: q.version, body, answer: d.answer, changedBy: a.admin.id } });
            updated++;
          } else {
            const q = await tx.question.create({ data: { ...d, body, passageId, status: 'draft', createdById: a.admin.id } });
            await tx.questionVersion.create({ data: { questionId: q.id, version: 1, body, answer: d.answer, changedBy: a.admin.id } });
            created++;
          }
        }
        await tx.importJob.update({ where: { id: jobId }, data: { status: 'committed', committedAt: new Date(), rows: [] } });
        await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'import.committed', targetType: 'import', target: jobId, meta: { created, updated, skipped: job.rowsFailed }, ip: a.ip }, tx);
        return { created, updated };
      });
      return { jobId, status: 'committed', ...result, skippedRows: job.rowsFailed };
    } catch (e) {
      await this.prisma.importJob.update({ where: { id: jobId }, data: { status: 'failed' } });
      if (e instanceof ApiError) throw e;
      throw e;
    }
  }

  async jobs(adminId: string) {
    return this.prisma.importJob.findMany({ where: { adminId }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, fileName: true, status: true, rowsTotal: true, rowsOk: true, rowsFailed: true, createdAt: true, committedAt: true } });
  }

  async job(adminId: string, id: string) {
    const j = await this.prisma.importJob.findFirst({ where: { id, adminId }, select: { id: true, fileName: true, status: true, rowsTotal: true, rowsOk: true, rowsFailed: true, errors: true, createdAt: true, committedAt: true } });
    if (!j) throw notFound('Import job');
    return j;
  }

  /** Export in the same layout as the template, so an export can be edited and re-imported. */
  async exportQuestions(filter: Prisma.QuestionWhereInput, format: 'csv' | 'xlsx') {
    const total = await this.prisma.question.count({ where: filter });
    if (total > 20_000) throw badRequest('TOO_MANY_ROWS', `${total} questions match; narrow the filter (maximum 20000)`);
    const qs = await this.prisma.question.findMany({ where: filter, orderBy: { createdAt: 'asc' }, include: { passage: true } });
    const rows = qs.map((q) => questionToRow(q));
    return format === 'xlsx' ? { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'questions.xlsx', data: await writeXlsx(rows) } : { type: 'text/csv; charset=utf-8', name: 'questions.csv', data: writeCsv(rows) };
  }

  where(f: Parameters<QuestionsRepository['where']>[0]) {
    return this.repo.where(f);
  }
}
