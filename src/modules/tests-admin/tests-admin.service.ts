import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminPrincipal } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { createDraftFromLatest, publishTestVersion } from '../tests/test-publishing';
import { rng, sample } from './pick';
import { createTest, listTests, patchTest, pickInput, questionsInput, sectionsInput, VersionConfig } from './tests-admin.schemas';

type Actor = { admin: AdminPrincipal; ip?: string };

@Injectable()
export class TestsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  private log(a: Actor, action: string, target: string, meta?: unknown, before?: unknown, after?: unknown) {
    return this.audit.log({ actorType: 'admin', actor: a.admin.id, action, targetType: 'test', target, meta, before, after, ip: a.ip });
  }

  private async draft(testId: string, versionId: string) {
    const v = await this.prisma.testVersion.findFirst({ where: { id: versionId, testId } });
    if (!v) throw notFound('Test version');
    if (v.status !== 'draft') throw conflict('VERSION_LOCKED', `Version ${v.version} is ${v.status} and cannot be edited. Create a new draft version instead.`);
    return v;
  }

  // ------------------------------------------------------------------ create / read
  async create(a: Actor, input: z.infer<typeof createTest>) {
    const exam = await this.prisma.exam.findUnique({ where: { id: input.examId } });
    if (!exam) throw badRequest('UNKNOWN_EXAM', 'Exam does not exist');
    const paper = input.paperId ? await this.prisma.examPaper.findUnique({ where: { id: input.paperId } }) : null;
    if (input.paperId && (!paper || paper.examId !== input.examId)) throw badRequest('UNKNOWN_PAPER', 'Paper does not exist for this exam');
    if (input.kind === 'live' && input.mode !== 'live') throw badRequest('KIND_MODE_MISMATCH', 'A live test must use mode "live"');
    const c = input.config;
    // The paper's pattern is the default; anything in `config` overrides it.
    const durationMin = c.durationMin ?? paper?.durationMin;
    if (!durationMin) throw badRequest('DURATION_REQUIRED', 'Pick a paper or give durationMin');
    return this.prisma.$transaction(async (tx) => {
      const test = await tx.test.create({ data: { examId: input.examId, paperId: paper?.id, titleEn: input.titleEn, titleHi: input.titleHi, kind: input.kind, mode: input.mode, access: input.access, subjectCode: input.subjectCode, topicCode: input.topicCode, pyqYear: input.pyqYear, createdById: a.admin.id } });
      const v = await tx.testVersion.create({
        data: {
          testId: test.id,
          version: 1,
          durationMin,
          correctMarks: c.correctMarks ?? paper?.correctMarks ?? 1,
          negativeFraction: c.negativeFraction ?? paper?.negativeFraction ?? 0,
          qualifyingPct: c.qualifyingPct === undefined ? (paper?.qualifyingPct ?? null) : c.qualifyingPct,
          qualifyingPctReserved: c.qualifyingPctReserved === undefined ? (paper?.qualifyingPctReserved ?? null) : c.qualifyingPctReserved,
          countsTowardMerit: c.countsTowardMerit ?? paper?.countsTowardMerit ?? true,
          shuffleQuestions: c.shuffleQuestions ?? true,
          sectionalTimers: c.sectionalTimers ?? false,
          attemptLimit: c.attemptLimit ?? null,
          startsAt: c.startsAt ?? null,
          endsAt: c.endsAt ?? null,
          resultReleaseAt: c.resultReleaseAt ?? null,
          instructionsEn: c.instructionsEn ?? null,
          instructionsHi: c.instructionsHi ?? null,
        },
      });
      await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'test.created', targetType: 'test', target: test.id, after: { titleEn: input.titleEn, kind: input.kind, examId: input.examId }, ip: a.ip }, tx);
      return { test, version: v };
    });
  }

  async list(q: z.infer<typeof listTests>) {
    const where: Prisma.TestWhereInput = {
      examId: q.examId,
      kind: q.kind,
      ...(q.q ? { OR: [{ titleEn: { contains: q.q, mode: 'insensitive' } }, { titleHi: { contains: q.q, mode: 'insensitive' } }] } : {}),
      ...(q.state === 'archived' ? { archived: true } : q.state === 'published' ? { archived: false, publishedVersionId: { not: null } } : q.state === 'draft' ? { archived: false, publishedVersionId: null } : {}),
    };
    const [total, tests] = await Promise.all([
      this.prisma.test.count({ where }),
      this.prisma.test.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true, version: true, status: true, questionCount: true, startsAt: true } }, _count: { select: { versions: true } } } }),
    ]);
    return {
      page: q.page,
      pageSize: q.pageSize,
      total,
      items: tests.map((t) => ({ id: t.id, titleEn: t.titleEn, titleHi: t.titleHi, examId: t.examId, kind: t.kind, mode: t.mode, access: t.access, archived: t.archived, published: !!t.publishedVersionId, latestVersion: t.versions[0] ?? null, versionCount: t._count.versions, createdAt: t.createdAt })),
    };
  }

  async get(id: string) {
    const test = await this.prisma.test.findUnique({ where: { id }, include: { versions: { orderBy: { version: 'desc' }, include: { sections: { orderBy: { position: 'asc' } }, _count: { select: { questions: true, attempts: true } } } } } });
    if (!test) throw notFound('Test');
    return test;
  }

  /** A version with its questions (previews), for the builder screen. */
  async version(testId: string, versionId: string) {
    const v = await this.prisma.testVersion.findFirst({ where: { id: versionId, testId }, include: { sections: { orderBy: { position: 'asc' } }, questions: { orderBy: { position: 'asc' } } } });
    if (!v) throw notFound('Test version');
    const ids = v.questions.map((q) => q.questionId);
    const qs = new Map((await this.prisma.question.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, type: true, topicCode: true, difficulty: true, status: true, hasEn: true, hasHi: true, body: true } })).map((q) => [q.id, q]));
    const secPos = new Map(v.sections.map((s) => [s.id, s.position]));
    const items = v.questions.map((t) => {
      const q = qs.get(t.questionId);
      const b = (q?.body ?? {}) as { en?: { stem?: string; assertion?: string }; hi?: { stem?: string; assertion?: string } };
      return { tvqId: t.id, position: t.position, sectionPos: t.sectionId ? (secPos.get(t.sectionId) ?? null) : null, marks: t.marks, questionId: t.questionId, code: q?.code, type: q?.type, topicCode: q?.topicCode, difficulty: q?.difficulty, status: q?.status, hasEn: q?.hasEn, hasHi: q?.hasHi, preview: String(b.en?.stem ?? b.en?.assertion ?? b.hi?.stem ?? b.hi?.assertion ?? '').slice(0, 120) };
    });
    const marks = items.reduce((n, i) => n + (i.marks ?? v.correctMarks), 0);
    const readiness = this.readiness(v, items);
    return { ...v, questions: undefined, items, totalMarks: marks, readiness };
  }

  /** What still blocks publishing, so the builder can show a checklist instead of an error after the click. */
  private readiness(v: { sectionalTimers: boolean; startsAt: Date | null; endsAt: Date | null; resultReleaseAt: Date | null; sections: Array<{ position: number; durationMin: number | null }> }, items: Array<{ status?: string; sectionPos: number | null; position: number; code?: string | null }>) {
    const problems: string[] = [];
    if (items.length === 0) problems.push('no questions');
    for (const i of items) if (i.status && i.status !== 'published') problems.push(`question ${i.code ?? i.position + 1} is ${i.status}`);
    if (v.sections.length > 0 && items.some((i) => i.sectionPos == null)) problems.push('some questions have no section');
    if (v.sectionalTimers && v.sections.some((s) => !s.durationMin)) problems.push('every section needs a duration for sectional timers');
    if (v.startsAt && v.endsAt && v.endsAt <= v.startsAt) problems.push('entry close must be after the start');
    return { ready: problems.length === 0, problems };
  }

  async patch(a: Actor, id: string, patch: z.infer<typeof patchTest>) {
    const before = await this.prisma.test.findUnique({ where: { id } });
    if (!before) throw notFound('Test');
    const t = await this.prisma.test.update({ where: { id }, data: patch });
    await this.log(a, 'test.updated', id, undefined, { titleEn: before.titleEn, access: before.access }, patch);
    return t;
  }

  // ------------------------------------------------------------------ draft editing
  async updateConfig(a: Actor, testId: string, versionId: string, cfg: VersionConfig) {
    const v = await this.draft(testId, versionId);
    const next = { ...v, ...cfg };
    if (next.qualifyingPctReserved != null && next.qualifyingPct != null && next.qualifyingPctReserved > next.qualifyingPct) throw badRequest('INVALID_QUALIFYING', 'Reserved cut-off cannot be higher than the general cut-off');
    const updated = await this.prisma.testVersion.update({ where: { id: versionId }, data: cfg });
    await this.log(a, 'test.version_config', testId, { versionId }, undefined, cfg);
    return updated;
  }

  async setSections(a: Actor, testId: string, versionId: string, input: z.infer<typeof sectionsInput>) {
    const v = await this.draft(testId, versionId);
    await this.prisma.$transaction(async (tx) => {
      await tx.testVersionQuestion.updateMany({ where: { versionId }, data: { sectionId: null } });
      await tx.testSection.deleteMany({ where: { versionId } });
      for (const [position, s] of input.sections.entries()) await tx.testSection.create({ data: { versionId, position, nameEn: s.nameEn, nameHi: s.nameHi, durationMin: s.durationMin } });
      if (input.sections.length === 0 && v.sectionalTimers) await tx.testVersion.update({ where: { id: versionId }, data: { sectionalTimers: false } });
    });
    await this.log(a, 'test.sections_set', testId, { versionId, count: input.sections.length });
    return { sections: input.sections.length, note: 'Questions were detached from sections; assign them again with the questions list.' };
  }

  async setQuestions(a: Actor, testId: string, versionId: string, input: z.infer<typeof questionsInput>) {
    await this.draft(testId, versionId);
    const ids = input.items.map((i) => i.questionId);
    if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_QUESTION', 'A question can appear only once in a test');
    const found = await this.prisma.question.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, code: true } });
    const known = new Map(found.map((q) => [q.id, q]));
    const unknown = ids.filter((i) => !known.has(i));
    if (unknown.length) throw badRequest('UNKNOWN_QUESTION', 'Some questions do not exist', unknown);
    const archived = found.filter((q) => q.status === 'archived').map((q) => q.code ?? q.id);
    if (archived.length) throw badRequest('ARCHIVED_QUESTION', 'Archived questions cannot be added', archived);
    const sections = await this.prisma.testSection.findMany({ where: { versionId } });
    const byPos = new Map(sections.map((s) => [s.position, s.id]));
    for (const i of input.items) {
      if (i.sectionPos !== undefined && !byPos.has(i.sectionPos)) throw badRequest('UNKNOWN_SECTION', `Section ${i.sectionPos} does not exist; define sections first`);
      if (sections.length > 0 && i.sectionPos === undefined) throw badRequest('SECTION_REQUIRED', 'Every question needs a sectionPos when the test has sections');
    }
    // Sections keep their questions together, in section order.
    const ordered = [...input.items].sort((x, y) => (x.sectionPos ?? 0) - (y.sectionPos ?? 0));
    await this.prisma.$transaction(async (tx) => {
      await tx.testVersionQuestion.deleteMany({ where: { versionId } });
      await tx.testVersionQuestion.createMany({ data: ordered.map((i, position) => ({ versionId, position, questionId: i.questionId, questionVersion: 1, marks: i.marks ?? null, sectionId: i.sectionPos === undefined ? null : byPos.get(i.sectionPos) })) });
    });
    await this.log(a, 'test.questions_set', testId, { versionId, count: ordered.length });
    return { count: ordered.length, notPublished: found.filter((q) => q.status !== 'published').map((q) => q.code ?? q.id) };
  }

  /** Rule-based selection: "10 hard Polity, 5 easy History". Nothing is saved when `preview` is set or a rule cannot be filled. */
  async pick(a: Actor, testId: string, versionId: string, input: z.infer<typeof pickInput>) {
    await this.draft(testId, versionId);
    const existing = await this.prisma.testVersionQuestion.findMany({ where: { versionId }, orderBy: { position: 'asc' } });
    const taken = new Set(existing.map((e) => e.questionId));
    if (input.excludeUsedInTests) {
      const used = await this.prisma.testVersionQuestion.findMany({ where: { version: { status: 'published', testId: { not: testId } } }, select: { questionId: true } });
      for (const u of used) taken.add(u.questionId);
    }
    const seed = input.seed ?? `${versionId}:${Date.now()}`;
    const random = rng(seed);
    const picked: Array<{ questionId: string; sectionPos?: number; rule: number }> = [];
    const shortages: Array<{ rule: number; requested: number; available: number }> = [];
    for (const [ri, r] of input.rules.entries()) {
      const candidates = await this.prisma.question.findMany({
        where: { status: 'published', topicCode: r.topicCode, difficulty: r.difficulty, type: r.type, source: r.source, ...(input.bothLanguagesOnly ? { hasEn: true, hasHi: true } : {}), id: { notIn: [...taken] } },
        select: { id: true },
      });
      if (candidates.length < r.count) shortages.push({ rule: ri, requested: r.count, available: candidates.length });
      for (const id of sample(candidates.map((c) => c.id), r.count, random)) {
        taken.add(id);
        picked.push({ questionId: id, sectionPos: r.sectionPos, rule: ri });
      }
    }
    if (shortages.length && !input.allowPartial) throw conflict('NOT_ENOUGH_QUESTIONS', 'Not enough published questions for some rules', { shortages });
    if (input.preview) return { preview: true, seed, picked: picked.length, shortages, questionIds: picked.map((p) => p.questionId) };

    const sections = await this.prisma.testSection.findMany({ where: { versionId } });
    const byPos = new Map(sections.map((s) => [s.position, s.id]));
    for (const p of picked) {
      if (p.sectionPos !== undefined && !byPos.has(p.sectionPos)) throw badRequest('UNKNOWN_SECTION', `Section ${p.sectionPos} does not exist`);
      if (sections.length > 0 && p.sectionPos === undefined) throw badRequest('SECTION_REQUIRED', 'Every rule needs a sectionPos when the test has sections');
    }
    await this.prisma.$transaction(async (tx) => {
      let pos = existing.length;
      for (const p of picked) await tx.testVersionQuestion.create({ data: { versionId, position: pos++, questionId: p.questionId, questionVersion: 1, sectionId: p.sectionPos === undefined ? null : byPos.get(p.sectionPos) } });
    });
    await this.log(a, 'test.picked', testId, { versionId, picked: picked.length, seed, shortages });
    return { preview: false, seed, picked: picked.length, shortages };
  }

  // ------------------------------------------------------------------ versions and publishing
  async newDraft(a: Actor, testId: string) {
    const draft = await this.prisma.$transaction((tx) => createDraftFromLatest(tx, testId));
    await this.log(a, 'test.draft_created', testId, { versionId: draft.id, version: draft.version });
    return draft;
  }

  async discardDraft(a: Actor, testId: string, versionId: string) {
    const v = await this.draft(testId, versionId);
    if ((await this.prisma.testVersion.count({ where: { testId } })) === 1) throw conflict('ONLY_VERSION', 'This is the only version; delete the test instead');
    await this.prisma.testVersion.delete({ where: { id: v.id } });
    await this.log(a, 'test.draft_discarded', testId, { versionId });
  }

  async publish(a: Actor, testId: string, versionId: string) {
    const test = await this.prisma.test.findUnique({ where: { id: testId } });
    if (!test) throw notFound('Test');
    await this.draft(testId, versionId);
    const requireBoth = await this.settings.get('content.requireBothLanguages');
    const published = await this.prisma.$transaction(async (tx) => {
      const v = await publishTestVersion(tx, versionId, { requireBothLanguages: requireBoth, publishedById: a.admin.id });
      await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'test.published', targetType: 'test', target: testId, meta: { versionId, version: v.version }, ip: a.ip }, tx);
      return v;
    });
    return published;
  }

  async setArchived(a: Actor, testId: string, archived: boolean) {
    const t = await this.prisma.test.findUnique({ where: { id: testId } });
    if (!t) throw notFound('Test');
    await this.prisma.test.update({ where: { id: testId }, data: { archived } });
    await this.log(a, archived ? 'test.archived' : 'test.unarchived', testId);
  }

  async remove(a: Actor, testId: string) {
    const t = await this.prisma.test.findUnique({ where: { id: testId }, include: { versions: { select: { status: true, _count: { select: { attempts: true } } } } } });
    if (!t) throw notFound('Test');
    if (t.versions.some((v) => v.status !== 'draft' || v._count.attempts > 0)) throw conflict('HAS_HISTORY', 'This test was published or attempted; archive it instead');
    await this.prisma.test.delete({ where: { id: testId } });
    await this.log(a, 'test.deleted', testId, { titleEn: t.titleEn });
  }
}

