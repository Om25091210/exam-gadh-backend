import { z } from 'zod';
import { bool, code, pageQuery, uuid } from '../../common/zod';
import { sanitizeRichText, stripMarkers } from '../../common/rich-text';
import { QUESTION_TYPES, QuestionBody, validateQuestionBody } from './question.schemas';

export const passageInput = z.object({ en: z.string().trim().min(1).max(8000).optional(), hi: z.string().trim().min(1).max(8000).optional() }).refine((p) => p.en || p.hi, { message: 'provide the passage in at least one language' });

const base = z.object({
  code: code.optional(),
  type: z.enum(QUESTION_TYPES),
  topicCode: code,
  subtopicCode: code.nullable().optional(),
  difficulty: z.number().int().min(1).max(3).default(2),
  answer: z.number().int().min(0).max(3),
  body: z.unknown(),
  passage: passageInput.optional(),
  passageId: uuid.optional(),
  imageKey: z.string().regex(/^public\/question-images\/[A-Za-z0-9/_.-]{3,200}$/, 'invalid image key').nullable().optional(),
  source: z.enum(['original', 'pyq']).default('original'),
  pyqYear: z.number().int().min(1950).max(2100).nullable().optional(),
  pyqExamId: code.nullable().optional(),
  pyqPaperCode: code.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
});

export const questionInput = base.superRefine((q, ctx) => {
  if (q.type === 'passage' && !q.passage && !q.passageId) ctx.addIssue({ code: 'custom', path: ['passage'], message: 'a passage question needs a passage or passageId' });
  if (q.type !== 'passage' && (q.passage || q.passageId)) ctx.addIssue({ code: 'custom', path: ['passage'], message: 'only passage questions take a passage' });
  if (q.source === 'pyq' && !q.pyqYear) ctx.addIssue({ code: 'custom', path: ['pyqYear'], message: 'previous-year questions need the year' });
});

export type QuestionInput = z.infer<typeof questionInput>;

export interface PreparedQuestion {
  data: {
    code?: string;
    type: QuestionInput['type'];
    topicCode: string;
    subtopicCode: string | null;
    difficulty: number;
    answer: number;
    body: QuestionBody;
    imageKey: string | null;
    source: string;
    pyqYear: number | null;
    pyqExamId: string | null;
    pyqPaperCode: string | null;
    tags: string[];
    hasEn: boolean;
    hasHi: boolean;
    contentHash: string;
    searchText: string;
  };
  passage?: { en?: string; hi?: string };
  passageId?: string;
}

const searchTextOf = (body: QuestionBody) =>
  [body.en, body.hi]
    .filter(Boolean)
    .map((l) => stripMarkers([l!.stem, (l as Record<string, unknown>).assertion, (l as Record<string, unknown>).reason, ...(((l as Record<string, unknown>).statements as string[]) ?? [])].filter(Boolean).join(' ')))
    .join(' ')
    .toLowerCase()
    .slice(0, 4000);

/** Validates the type-specific bilingual body and derives everything stored next to it. */
export function prepareQuestion(input: QuestionInput): { ok: true; value: PreparedQuestion } | { ok: false; issues: Array<{ path: string; message: string }> } {
  const v = validateQuestionBody(input.type, input.body);
  if (!v.ok) return v;
  const passage = input.passage ? { en: input.passage.en ? sanitizeRichText(input.passage.en) : undefined, hi: input.passage.hi ? sanitizeRichText(input.passage.hi) : undefined } : undefined;
  return {
    ok: true,
    value: {
      data: {
        code: input.code,
        type: input.type,
        topicCode: input.topicCode,
        subtopicCode: input.subtopicCode ?? null,
        difficulty: input.difficulty,
        answer: input.answer,
        body: v.value.body,
        imageKey: input.imageKey ?? null,
        source: input.source,
        pyqYear: input.pyqYear ?? null,
        pyqExamId: input.pyqExamId ?? null,
        pyqPaperCode: input.pyqPaperCode ?? null,
        tags: input.tags,
        hasEn: v.value.hasEn,
        hasHi: v.value.hasHi,
        contentHash: v.value.contentHash,
        searchText: searchTextOf(v.value.body),
      },
      passage,
      passageId: input.passageId,
    },
  };
}

export const listQuery = z.object({
  ...pageQuery,
  status: z.enum(['draft', 'in_review', 'published', 'archived']).optional(),
  type: z.enum(QUESTION_TYPES).optional(),
  topicCode: code.optional(),
  subtopicCode: code.optional(),
  difficulty: z.coerce.number().int().min(1).max(3).optional(),
  source: z.enum(['original', 'pyq']).optional(),
  pyqYear: z.coerce.number().int().optional(),
  // translation-missing filter: which language is absent
  missing: z.enum(['hi', 'en', 'any']).optional(),
  reported: bool.optional(),
  q: z.string().trim().min(2).max(100).optional(),
  tag: z.string().trim().max(30).optional(),
});

export const transitionInput = z.object({ to: z.enum(['draft', 'in_review', 'published', 'archived']) });
export const bulkTransitionInput = z.object({ ids: z.array(uuid).min(1).max(200), to: z.enum(['draft', 'in_review', 'published', 'archived']) });
export const duplicateCheckInput = z.object({ type: z.enum(QUESTION_TYPES), body: z.unknown() });
export const resolveReportInput = z.object({ status: z.enum(['resolved', 'dismissed']), note: z.string().trim().max(500).optional() });
export const reportListQuery = z.object({ ...pageQuery, status: z.enum(['open', 'resolved', 'dismissed']).default('open') });
