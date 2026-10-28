import { z } from 'zod';
import { bool, code, pageQuery, uuid } from '../../common/zod';

const text = (max = 200) => z.string().trim().min(1).max(max);
const date = z.coerce.date();

export const versionConfig = z
  .object({
    durationMin: z.number().int().min(1).max(600),
    correctMarks: z.number().positive().max(100),
    negativeFraction: z.number().min(0).max(1),
    qualifyingPct: z.number().min(0).max(100).nullable(),
    qualifyingPctReserved: z.number().min(0).max(100).nullable(),
    countsTowardMerit: z.boolean(),
    shuffleQuestions: z.boolean(),
    sectionalTimers: z.boolean(),
    attemptLimit: z.number().int().min(1).max(50).nullable(),
    startsAt: date.nullable(),
    endsAt: date.nullable(),
    resultReleaseAt: date.nullable(),
    instructionsEn: z.string().trim().max(5000).nullable(),
    instructionsHi: z.string().trim().max(5000).nullable(),
  })
  .partial();
export type VersionConfig = z.infer<typeof versionConfig>;

export const createTest = z.object({
  examId: code,
  paperId: z.string().min(2).max(60).optional(),
  titleEn: text(),
  titleHi: text(),
  kind: z.enum(['diagnostic', 'mock', 'topic', 'subject', 'pyq', 'csat', 'sectional', 'daily', 'live']),
  mode: z.enum(['static', 'live']).default('static'),
  access: z.enum(['free', 'paid']).default('free'),
  subjectCode: code.optional(),
  topicCode: code.optional(),
  pyqYear: z.number().int().min(1950).max(2100).optional(),
  config: versionConfig.default({}),
});

export const patchTest = z.object({ titleEn: text().optional(), titleHi: text().optional(), access: z.enum(['free', 'paid']).optional(), subjectCode: code.nullable().optional(), topicCode: code.nullable().optional(), pyqYear: z.number().int().min(1950).max(2100).nullable().optional() });

export const sectionsInput = z.object({ sections: z.array(z.object({ nameEn: text(80), nameHi: text(80), durationMin: z.number().int().min(1).max(600).nullable().default(null) })).max(12) });

export const questionsInput = z.object({
  items: z
    .array(z.object({ questionId: uuid, sectionPos: z.number().int().min(0).max(11).optional(), marks: z.number().positive().max(100).optional() }))
    .max(500),
});

export const pickInput = z.object({
  rules: z
    .array(z.object({ topicCode: code, difficulty: z.number().int().min(1).max(3).optional(), type: z.enum(['single', 'multi_statement', 'match', 'assertion_reason', 'chronology', 'passage']).optional(), count: z.number().int().min(1).max(200), sectionPos: z.number().int().min(0).max(11).optional(), source: z.enum(['original', 'pyq']).optional() }))
    .min(1)
    .max(30),
  seed: z.string().max(60).optional(),
  preview: z.boolean().default(false),
  allowPartial: z.boolean().default(false),
  excludeUsedInTests: z.boolean().default(false),
  bothLanguagesOnly: z.boolean().default(false),
});

export const listTests = z.object({
  ...pageQuery,
  examId: code.optional(),
  kind: z.enum(['diagnostic', 'mock', 'topic', 'subject', 'pyq', 'csat', 'sectional', 'daily', 'live']).optional(),
  state: z.enum(['draft', 'published', 'archived']).optional(),
  q: z.string().trim().min(2).max(80).optional(),
});

export const keyCorrection = z.object({ tvqId: uuid, newAnswer: z.number().int().min(0).max(3), reason: z.string().trim().min(5).max(300), updateQuestionBank: bool.default(true) });
export const analyticsQuery = z.object({ versionId: uuid.optional() });

export const seriesInput = z.object({ examId: code, titleEn: text(), titleHi: text(), descEn: z.string().trim().max(1000).optional(), descHi: z.string().trim().max(1000).optional(), access: z.enum(['free', 'paid']).default('paid'), sort: z.number().int().default(0) });
export const seriesPatch = seriesInput.omit({ examId: true }).partial().extend({ status: z.enum(['draft', 'published', 'archived']).optional() });
export const seriesItems = z.object({ testIds: z.array(uuid).max(300) });
