import { AccessLevel, Prisma } from '@prisma/client';
import { questionContentHash } from '../src/modules/questions/question.schemas';
import { publishTestVersion } from '../src/modules/tests/test-publishing';
import { PrismaService } from '../src/prisma/prisma.service';

export async function baseTaxonomy(prisma: PrismaService) {
  await prisma.exam.create({ data: { id: 'cgpsc', nameEn: 'CGPSC', nameHi: 'CGPSC', shortEn: 'CGPSC', shortHi: 'CGPSC' } });
  await prisma.examPaper.create({ data: { id: 'cgpsc_pre_gs', examId: 'cgpsc', code: 'PRE_GS', nameEn: 'GS', nameHi: 'GS', questionCount: 10, totalMarks: 20, durationMin: 10 } });
  await prisma.subject.create({ data: { code: 'S1', nameEn: 'Subject', nameHi: 'विषय' } });
  for (const t of ['T1', 'T2']) await prisma.topic.create({ data: { code: t, subjectCode: 'S1', nameEn: `Topic ${t}`, nameHi: `टॉपिक ${t}` } });
}

export const makeBody = (i: number) => ({
  en: { stem: `Question ${i}`, options: ['a', 'b', 'c', 'd'], explanation: `explanation ${i}` },
  hi: { stem: `प्रश्न ${i}`, options: ['अ', 'ब', 'स', 'द'], explanation: `व्याख्या ${i}` },
});

export async function makeQuestions(prisma: PrismaService, n: number, prefix = 'Q') {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const body = makeBody(i);
    const q = await prisma.question.create({
      data: { code: `${prefix}${i}`, topicCode: i % 2 === 0 ? 'T1' : 'T2', answer: i % 4, status: 'published', body, hasEn: true, hasHi: true, contentHash: questionContentHash('single', body as never) + prefix + i },
    });
    out.push(q.id);
  }
  return out;
}

export interface MakeTestOptions {
  n?: number;
  sections?: Array<{ count: number; durationMin?: number }>;
  sectionalTimers?: boolean;
  durationMin?: number;
  resultReleaseAt?: Date;
  qualifyingPct?: number;
  qualifyingPctReserved?: number;
  mode?: 'static' | 'live';
  startsAt?: Date;
  endsAt?: Date;
  attemptLimit?: number;
  access?: AccessLevel;
  shuffle?: boolean;
  title?: string;
  questionIds?: string[];
  kind?: 'mock' | 'live' | 'topic';
}

/** Builds and publishes a test. Question i has correct option i % 4. */
export async function makeTest(prisma: PrismaService, o: MakeTestOptions = {}) {
  const n = o.n ?? 6;
  const qids = o.questionIds ?? (await makeQuestions(prisma, n, `Q${Math.random().toString(36).slice(2, 6)}-`));
  return prisma.$transaction(async (tx) => {
    const test = await tx.test.create({ data: { examId: 'cgpsc', paperId: 'cgpsc_pre_gs', titleEn: o.title ?? 'Test', titleHi: o.title ?? 'टेस्ट', kind: o.kind ?? 'mock', mode: o.mode ?? 'static', access: o.access ?? 'free' } });
    const v = await tx.testVersion.create({
      data: {
        testId: test.id,
        version: 1,
        durationMin: o.durationMin ?? 10,
        correctMarks: 2,
        negativeFraction: 1 / 3,
        shuffleQuestions: o.shuffle ?? false,
        sectionalTimers: o.sectionalTimers ?? false,
        resultReleaseAt: o.resultReleaseAt,
        qualifyingPct: o.qualifyingPct,
        qualifyingPctReserved: o.qualifyingPctReserved,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        attemptLimit: o.attemptLimit,
        countsTowardMerit: o.qualifyingPct == null,
      },
    });
    const sectionDefs = o.sections ?? [{ count: qids.length }];
    const useSections = !!o.sections;
    let pos = 0;
    for (const [si, s] of sectionDefs.entries()) {
      const sec = useSections ? await tx.testSection.create({ data: { versionId: v.id, position: si, nameEn: `Section ${si + 1}`, nameHi: `खंड ${si + 1}`, durationMin: s.durationMin } }) : null;
      for (let k = 0; k < s.count; k++, pos++) {
        await tx.testVersionQuestion.create({ data: { versionId: v.id, sectionId: sec?.id, position: pos, questionId: qids[pos], questionVersion: 1 } });
      }
    }
    await publishTestVersion(tx, v.id);
    const tvqs = await tx.testVersionQuestion.findMany({ where: { versionId: v.id }, orderBy: { position: 'asc' } });
    return { testId: test.id, versionId: v.id, questionIds: qids, tvqIds: tvqs.map((t) => t.id) };
  });
}

export const answerKey = async (prisma: PrismaService, versionId: string) =>
  new Map((await prisma.testVersionQuestion.findMany({ where: { versionId } })).map((t) => [t.id, (t.snapshot as unknown as { answer: number }).answer]));

export type Json = Prisma.InputJsonValue;
