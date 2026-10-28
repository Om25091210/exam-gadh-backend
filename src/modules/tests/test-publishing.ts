import { Prisma } from '@prisma/client';
import { ApiError } from '../../common/api-error';
import { QuestionBody } from '../questions/question.schemas';

export interface PublishOptions {
  /** When true every question must have both languages (setting `content.requireBothLanguages`). */
  requireBothLanguages?: boolean;
  publishedById?: string;
}

export interface PublishProblem {
  field: string;
  message: string;
}

/**
 * Freezes a draft version: snapshots every question (body + answer key + passage), computes the max score,
 * archives the previously published version and points the test at the new one.
 * Runs inside the caller's transaction. Published versions are immutable (also enforced by DB triggers).
 */
export async function publishTestVersion(tx: Prisma.TransactionClient, versionId: string, opts: PublishOptions = {}) {
  const version = await tx.testVersion.findUnique({
    where: { id: versionId },
    include: { sections: { orderBy: { position: 'asc' } }, questions: { orderBy: { position: 'asc' } }, test: true },
  });
  if (!version) throw new ApiError(404, 'NOT_FOUND', 'Test version not found');
  if (version.status !== 'draft') throw new ApiError(409, 'NOT_DRAFT', 'Only a draft version can be published');

  const problems: PublishProblem[] = [];
  if (version.questions.length === 0) problems.push({ field: 'questions', message: 'add at least one question' });
  if (version.startsAt && version.endsAt && version.endsAt <= version.startsAt) {
    problems.push({ field: 'endsAt', message: 'entry close must be after the start' });
  }
  if (version.test.mode === 'live' && !version.startsAt) problems.push({ field: 'startsAt', message: 'live tests need a start time' });
  if (version.resultReleaseAt && version.endsAt && version.resultReleaseAt < version.endsAt) {
    problems.push({ field: 'resultReleaseAt', message: 'results cannot be released before entry closes' });
  }
  if (version.sectionalTimers) {
    if (version.sections.length === 0) problems.push({ field: 'sections', message: 'sectional timers need sections' });
    for (const s of version.sections) {
      if (!s.durationMin) problems.push({ field: `sections.${s.position}.durationMin`, message: 'every section needs a duration' });
    }
  }
  const sectionIds = new Set(version.sections.map((s) => s.id));
  for (const q of version.questions) {
    if (version.sections.length > 0 && (!q.sectionId || !sectionIds.has(q.sectionId))) {
      problems.push({ field: `questions.${q.position}`, message: 'every question must belong to a section when sections exist' });
    }
  }

  const questions = await tx.question.findMany({
    where: { id: { in: version.questions.map((q) => q.questionId) } },
    include: { passage: true },
  });
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const tvq of version.questions) {
    const q = byId.get(tvq.questionId);
    if (!q) {
      problems.push({ field: `questions.${tvq.position}`, message: 'question no longer exists' });
      continue;
    }
    if (q.status !== 'published') problems.push({ field: `questions.${tvq.position}`, message: `question ${q.code ?? q.id} is ${q.status}, publish it first` });
    if (opts.requireBothLanguages && !(q.hasEn && q.hasHi)) {
      problems.push({ field: `questions.${tvq.position}`, message: `question ${q.code ?? q.id} is missing a translation` });
    }
    if (q.type === 'passage' && !q.passage) problems.push({ field: `questions.${tvq.position}`, message: 'passage question has no passage' });
  }
  if (problems.length) throw new ApiError(422, 'PUBLISH_BLOCKED', 'The test cannot be published yet', problems);

  let maxScore = 0;
  for (const tvq of version.questions) {
    const q = byId.get(tvq.questionId)!;
    maxScore += tvq.marks ?? version.correctMarks;
    await tx.testVersionQuestion.update({
      where: { id: tvq.id },
      data: {
        questionVersion: q.version,
        snapshot: {
          type: q.type,
          body: q.body as unknown as QuestionBody,
          answer: q.answer,
          passage: q.passage ? (q.passage.body as Prisma.JsonObject) : null,
          topicCode: q.topicCode,
          subtopicCode: q.subtopicCode,
          difficulty: q.difficulty,
          imageKey: q.imageKey,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  await tx.testVersion.update({
    where: { id: version.id },
    data: { maxScore: Math.round(maxScore * 100) / 100, questionCount: version.questions.length },
  });
  // Archive the version students were seeing until now (its attempts keep working).
  await tx.testVersion.updateMany({
    where: { testId: version.testId, status: 'published', id: { not: version.id } },
    data: { status: 'archived' },
  });
  const published = await tx.testVersion.update({
    where: { id: version.id },
    data: { status: 'published', publishedAt: new Date(), publishedById: opts.publishedById ?? null },
  });
  await tx.test.update({ where: { id: version.testId }, data: { publishedVersionId: version.id } });
  return published;
}

/** Editing a published test: clone its latest version into a new draft (config, sections and question links). */
export async function createDraftFromLatest(tx: Prisma.TransactionClient, testId: string) {
  const latest = await tx.testVersion.findFirst({
    where: { testId },
    orderBy: { version: 'desc' },
    include: { sections: true, questions: true },
  });
  if (!latest) throw new ApiError(404, 'NOT_FOUND', 'Test has no version');
  if (latest.status === 'draft') return latest; // already editing
  const draft = await tx.testVersion.create({
    data: {
      testId,
      version: latest.version + 1,
      status: 'draft',
      durationMin: latest.durationMin,
      correctMarks: latest.correctMarks,
      negativeFraction: latest.negativeFraction,
      qualifyingPct: latest.qualifyingPct,
      qualifyingPctReserved: latest.qualifyingPctReserved,
      countsTowardMerit: latest.countsTowardMerit,
      shuffleQuestions: latest.shuffleQuestions,
      sectionalTimers: latest.sectionalTimers,
      attemptLimit: latest.attemptLimit,
      startsAt: latest.startsAt,
      endsAt: latest.endsAt,
      resultReleaseAt: latest.resultReleaseAt,
      instructionsEn: latest.instructionsEn,
      instructionsHi: latest.instructionsHi,
    },
  });
  const sectionMap = new Map<string, string>();
  for (const s of latest.sections) {
    const c = await tx.testSection.create({
      data: { versionId: draft.id, position: s.position, nameEn: s.nameEn, nameHi: s.nameHi, durationMin: s.durationMin },
    });
    sectionMap.set(s.id, c.id);
  }
  for (const q of latest.questions) {
    await tx.testVersionQuestion.create({
      data: {
        versionId: draft.id,
        sectionId: q.sectionId ? sectionMap.get(q.sectionId) : null,
        position: q.position,
        questionId: q.questionId,
        questionVersion: q.questionVersion,
        marks: q.marks,
      },
    });
  }
  return draft;
}
