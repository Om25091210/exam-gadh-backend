import { Injectable } from '@nestjs/common';
import { ContentStatus, Prisma } from '@prisma/client';
import { ApiError, badRequest, conflict, notFound } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';
import { sanitizeRichText } from '../../common/rich-text';
import { AdminPrincipal } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { Permission } from '../rbac/permissions';
import { SettingsService } from '../settings/settings.service';
import { prepareQuestion, PreparedQuestion, QuestionInput } from './question-input';
import { QuestionBody, validateQuestionBody } from './question.schemas';
import { QuestionsRepository } from './questions.repository';

type Actor = { admin: AdminPrincipal; ip?: string };

/** Who may move a question between states (maker/checker: an editor submits, someone with publish rights decides). */
const TRANSITIONS: Record<ContentStatus, Partial<Record<ContentStatus, Permission>>> = {
  draft: { in_review: 'content:write', published: 'content:publish' },
  in_review: { published: 'content:publish', draft: 'content:publish' },
  published: { archived: 'content:publish', draft: 'content:publish' },
  archived: { draft: 'content:publish' },
};

@Injectable()
export class QuestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: QuestionsRepository,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private prepare(input: QuestionInput) {
    const r = prepareQuestion(input);
    if (!r.ok) throw badRequest('VALIDATION_FAILED', 'The question is not valid', r.issues.map((i) => ({ field: i.path, problems: [i.message] })));
    return r.value;
  }

  private async assertTaxonomy(topicCode: string, subtopicCode: string | null) {
    const topic = await this.prisma.topic.findUnique({ where: { code: topicCode } });
    if (!topic) throw badRequest('UNKNOWN_TOPIC', `Topic ${topicCode} does not exist`);
    if (subtopicCode) {
      const sub = await this.prisma.subtopic.findUnique({ where: { code: subtopicCode } });
      if (!sub || sub.topicCode !== topicCode) throw badRequest('UNKNOWN_SUBTOPIC', `Subtopic ${subtopicCode} does not belong to ${topicCode}`);
    }
  }

  async list(f: Parameters<QuestionsRepository['where']>[0], page: { page: number; pageSize: number }) {
    const [total, rows] = await this.repo.list(this.repo.where(f), (page.page - 1) * page.pageSize, page.pageSize);
    return {
      page: page.page,
      pageSize: page.pageSize,
      total,
      items: rows.map(({ body, ...r }) => {
        const b = body as unknown as QuestionBody;
        return { ...r, preview: String(b.en?.stem ?? (b.en as Record<string, unknown> | undefined)?.assertion ?? b.hi?.stem ?? (b.hi as Record<string, unknown> | undefined)?.assertion ?? '').slice(0, 140) };
      }),
    };
  }

  async get(id: string) {
    const q = await this.repo.byId(id);
    if (!q) throw notFound('Question');
    const [history, usage] = await Promise.all([this.repo.history(id), this.repo.usage(id)]);
    return { ...q, history: history.map((h) => ({ version: h.version, changedBy: h.changedBy, changedAt: h.changedAt })), usedIn: usage.map((u) => u.version) };
  }

  async checkDuplicate(type: QuestionInput['type'], body: unknown) {
    const v = validateQuestionBody(type, body);
    if (!v.ok) throw badRequest('VALIDATION_FAILED', 'The question is not valid', v.issues.map((i) => ({ field: i.path, problems: [i.message] })));
    return { duplicates: await this.repo.byHash(v.value.contentHash) };
  }

  async create(a: Actor, input: QuestionInput, allowDuplicate: boolean) {
    const p = this.prepare(input);
    await this.assertTaxonomy(p.data.topicCode, p.data.subtopicCode);
    await this.assertNotDuplicate(p, undefined, allowDuplicate);
    if (p.data.code && (await this.prisma.question.findUnique({ where: { code: p.data.code } }))) throw conflict('CODE_IN_USE', `Code ${p.data.code} is already used`);
    const created = await this.prisma.$transaction(async (tx) => {
      const passageId = await this.resolvePassage(tx, p);
      const q = await tx.question.create({ data: { ...p.data, body: p.data.body as unknown as Prisma.InputJsonValue, passageId, createdById: a.admin.id, status: 'draft' } });
      await tx.questionVersion.create({ data: { questionId: q.id, version: 1, body: p.data.body as unknown as Prisma.InputJsonValue, answer: p.data.answer, changedBy: a.admin.id } });
      await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'question.created', targetType: 'question', target: q.id, after: { code: q.code, type: q.type, topicCode: q.topicCode }, ip: a.ip }, tx);
      return q;
    });
    return created;
  }

  async update(a: Actor, id: string, input: QuestionInput, allowDuplicate: boolean) {
    const before = await this.repo.byId(id);
    if (!before) throw notFound('Question');
    const p = this.prepare(input);
    await this.assertTaxonomy(p.data.topicCode, p.data.subtopicCode);
    await this.assertNotDuplicate(p, id, allowDuplicate);
    if (p.data.code && p.data.code !== before.code && (await this.prisma.question.findUnique({ where: { code: p.data.code } }))) throw conflict('CODE_IN_USE', `Code ${p.data.code} is already used`);

    const contentChanged = before.contentHash !== p.data.contentHash || before.answer !== p.data.answer || before.type !== p.data.type || JSON.stringify(before.body) !== JSON.stringify(p.data.body);
    // An edit by someone who cannot publish sends a published question back for review.
    const canPublish = a.admin.permissions.includes('content:publish');
    const status: ContentStatus = before.status === 'published' && !canPublish && contentChanged ? 'in_review' : before.status;
    return this.prisma.$transaction(async (tx) => {
      const passageId = await this.resolvePassage(tx, p, before.passageId);
      const q = await tx.question.update({
        where: { id },
        data: { ...p.data, code: p.data.code ?? before.code, body: p.data.body as unknown as Prisma.InputJsonValue, passageId, status, ...(contentChanged ? { version: { increment: 1 } } : {}) },
      });
      if (contentChanged) await tx.questionVersion.create({ data: { questionId: id, version: q.version, body: p.data.body as unknown as Prisma.InputJsonValue, answer: p.data.answer, changedBy: a.admin.id } });
      await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'question.updated', targetType: 'question', target: id, before: { status: before.status, answer: before.answer, version: before.version }, after: { status, answer: q.answer, version: q.version, contentChanged }, ip: a.ip }, tx);
      return q;
    });
  }

  private async assertNotDuplicate(p: PreparedQuestion, exceptId: string | undefined, allow: boolean) {
    if (allow) return;
    const dups = await this.repo.byHash(p.data.contentHash, exceptId);
    if (dups.length) throw conflict('DUPLICATE_QUESTION', 'A question with the same text already exists', { duplicates: dups });
  }

  private async resolvePassage(tx: Prisma.TransactionClient, p: PreparedQuestion, current?: string | null): Promise<string | null> {
    if (p.data.type !== 'passage') return null;
    if (p.passage) {
      if (current) {
        const existing = await tx.passage.findUnique({ where: { id: current } });
        if (existing) return (await tx.passage.update({ where: { id: current }, data: { body: p.passage as Prisma.InputJsonValue } })).id;
      }
      return (await tx.passage.create({ data: { body: p.passage as Prisma.InputJsonValue } })).id;
    }
    if (p.passageId) {
      if (!(await tx.passage.findUnique({ where: { id: p.passageId } }))) throw badRequest('UNKNOWN_PASSAGE', 'Passage not found');
      return p.passageId;
    }
    return current ?? null;
  }

  // ------------------------------------------------------------------ workflow
  async transition(a: Actor, id: string, to: ContentStatus) {
    const q = await this.repo.byId(id);
    if (!q) throw notFound('Question');
    return this.move(a, q, to);
  }

  async bulkTransition(a: Actor, ids: string[], to: ContentStatus) {
    const rows = new Map((await this.repo.byIds(ids)).map((q) => [q.id, q]));
    const results: Array<{ id: string; ok: boolean; status?: ContentStatus; error?: { code: string; message: string } }> = [];
    for (const id of ids) {
      const q = rows.get(id);
      if (!q) {
        results.push({ id, ok: false, error: { code: 'NOT_FOUND', message: 'Question not found' } });
        continue;
      }
      try {
        const moved = await this.move(a, q, to);
        results.push({ id, ok: true, status: moved.status });
      } catch (e) {
        if (e instanceof ApiError) results.push({ id, ok: false, error: { code: e.code, message: e.message } });
        else throw e;
      }
    }
    return { results, changed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  }

  private async move(a: Actor, q: NonNullable<Awaited<ReturnType<QuestionsRepository['byId']>>>, to: ContentStatus) {
    if (q.status === to) return q;
    const needed = TRANSITIONS[q.status][to];
    if (!needed) throw conflict('INVALID_TRANSITION', `A ${q.status} question cannot become ${to}`);
    if (!a.admin.permissions.includes(needed)) throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to do this', { required: needed });
    if (to === 'published' || to === 'in_review') {
      const v = validateQuestionBody(q.type, q.body);
      if (!v.ok) throw badRequest('INCOMPLETE_QUESTION', 'The question is not complete', v.issues);
      if (to === 'published' && (await this.settings.get('content.requireBothLanguages')) && !(q.hasEn && q.hasHi)) {
        throw conflict('TRANSLATION_MISSING', 'Both Hindi and English are required before publishing', { hasEn: q.hasEn, hasHi: q.hasHi });
      }
    }
    const updated = await this.prisma.question.update({ where: { id: q.id }, data: { status: to } });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: `question.${to}`, targetType: 'question', target: q.id, before: { status: q.status }, after: { status: to }, ip: a.ip });
    return updated;
  }

  async remove(a: Actor, id: string) {
    const q = await this.repo.byId(id);
    if (!q) throw notFound('Question');
    if (q.status !== 'draft') throw conflict('NOT_DRAFT', 'Only a draft question can be deleted; archive it instead');
    if ((await this.repo.usage(id)).length) throw conflict('IN_USE', 'A test uses this question; archive it instead');
    await this.prisma.question.delete({ where: { id } });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'question.deleted', targetType: 'question', target: id, before: { code: q.code, topicCode: q.topicCode }, ip: a.ip });
  }

  duplicates() {
    return this.repo.duplicateGroups();
  }

  async createPassage(a: Actor, body: { en?: string; hi?: string }) {
    const clean = { ...(body.en ? { en: sanitizeRichText(body.en) } : {}), ...(body.hi ? { hi: sanitizeRichText(body.hi) } : {}) };
    const p = await this.prisma.passage.create({ data: { body: clean } });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'passage.created', targetType: 'passage', target: p.id, ip: a.ip });
    return p;
  }

  async getPassage(id: string) {
    const p = await this.prisma.passage.findUnique({ where: { id }, include: { questions: { select: { id: true, code: true } } } });
    if (!p) throw notFound('Passage');
    return p;
  }

  // ------------------------------------------------------------------ student-reported issues
  async reports(status: string, page: { page: number; pageSize: number }) {
    const where = { status };
    const [total, items] = await Promise.all([
      this.prisma.questionReport.count({ where }),
      this.prisma.questionReport.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page.page - 1) * page.pageSize, take: page.pageSize, include: { question: { select: { id: true, code: true, topicCode: true, status: true } } } }),
    ]);
    return { page: page.page, pageSize: page.pageSize, total, items };
  }

  async resolveReport(a: Actor, id: string, status: 'resolved' | 'dismissed', note?: string) {
    const r = await this.prisma.questionReport.findUnique({ where: { id } });
    if (!r) throw notFound('Report');
    if (r.status !== 'open') throw conflict('ALREADY_HANDLED', 'This report was already handled');
    await this.prisma.$transaction(async (tx) => {
      await tx.questionReport.update({ where: { id }, data: { status, resolvedBy: a.admin.id, resolvedAt: new Date(), note: note ? `${r.note ? r.note + ' | ' : ''}admin: ${note}` : r.note } });
      await tx.$executeRaw`UPDATE "Question" SET "reportedCount" = GREATEST("reportedCount" - 1, 0) WHERE id = ${r.questionId}::uuid`;
    });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: `question_report.${status}`, targetType: 'question', target: r.questionId, meta: { reportId: id }, ip: a.ip });
  }
}
