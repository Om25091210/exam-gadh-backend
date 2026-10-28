import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sanitizeRichText, stripMarkers } from '../../common/rich-text';

export const QUESTION_TYPES = ['single', 'multi_statement', 'match', 'assertion_reason', 'chronology', 'passage'] as const;
export type QuestionTypeName = (typeof QUESTION_TYPES)[number];

const text = (max: number) =>
  z
    .string()
    .transform(sanitizeRichText)
    .pipe(z.string().min(1, 'must not be empty').max(max, `must be at most ${max} characters`));
const option = text(500);
const options = z.array(option).length(4, 'exactly 4 options are required');
const explanation = text(4000).optional();

const single = z.object({ stem: text(2000), options, explanation });
const multiStatement = single.extend({
  statements: z.array(text(600)).min(2).max(6),
  prompt: text(300).optional(),
});
const match = single.extend({
  listA: z.array(text(200)).min(2).max(6),
  listB: z.array(text(200)).min(2).max(6),
});
const assertionReason = z.object({
  stem: text(500).optional(),
  assertion: text(1000),
  reason: text(1000),
  options,
  explanation,
});
const chronology = single.extend({ items: z.array(text(300)).min(3).max(6) });

const byType = {
  single,
  multi_statement: multiStatement,
  match,
  assertion_reason: assertionReason,
  chronology,
  passage: single,
} as const;

export type LangBody = Record<string, unknown> & { options: string[]; stem?: string; explanation?: string };
export interface QuestionBody {
  en?: LangBody;
  hi?: LangBody;
}

export interface ValidatedQuestion {
  body: QuestionBody;
  hasEn: boolean;
  hasHi: boolean;
  contentHash: string;
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Validates and normalises a bilingual question body for its type.
 * At least one language must be complete; a language that is present must be valid.
 * Both languages must agree on the list sizes so the answer index means the same thing.
 */
export function validateQuestionBody(
  type: QuestionTypeName,
  raw: unknown,
): { ok: true; value: ValidatedQuestion } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: QuestionBody = {};
  const schema = byType[type];

  for (const lang of ['en', 'hi'] as const) {
    if (input[lang] === undefined || input[lang] === null) continue;
    const parsed = schema.safeParse(input[lang]);
    if (parsed.success) out[lang] = parsed.data as unknown as LangBody;
    else
      for (const i of parsed.error.issues) {
        issues.push({ path: [lang, ...i.path].join('.'), message: i.message });
      }
  }
  if (!out.en && !out.hi && issues.length === 0) {
    issues.push({ path: 'body', message: 'provide at least one language (en or hi)' });
  }
  if (out.en && out.hi) {
    for (const key of ['statements', 'listA', 'listB', 'items']) {
      const a = out.en[key] as unknown[] | undefined;
      const b = out.hi[key] as unknown[] | undefined;
      if (a && b && a.length !== b.length) {
        issues.push({ path: `hi.${key}`, message: `must have the same number of entries as en.${key}` });
      }
    }
    if (type === 'match') {
      const en = out.en as unknown as { listA: unknown[]; listB: unknown[] };
      if (en.listA.length !== en.listB.length) issues.push({ path: 'en.listB', message: 'listB must match listA in length' });
    }
  }
  if (type === 'match') {
    for (const lang of ['en', 'hi'] as const) {
      const l = out[lang] as unknown as { listA: unknown[]; listB: unknown[] } | undefined;
      if (l && l.listA.length !== l.listB.length) issues.push({ path: `${lang}.listB`, message: 'listB must match listA in length' });
    }
  }
  if (issues.length) return { ok: false, issues };

  return {
    ok: true,
    value: { body: out, hasEn: !!out.en, hasHi: !!out.hi, contentHash: questionContentHash(type, out) },
  };
}

/** Same question typed twice (case, spacing, punctuation, markers aside) gives the same hash. */
export function questionContentHash(type: string, body: QuestionBody): string {
  const norm = (s: string) =>
    stripMarkers(s)
      .toLowerCase()
      .replace(/[\s‌‍]+/g, ' ')
      .replace(/[.,;:!?'"()\-–—]/g, '')
      .trim();
  const part = (l?: LangBody) =>
    l ? norm(String(l.stem ?? l.assertion ?? '')) + '|' + l.options.map(norm).join('|') : '';
  return createHash('sha256').update([type, part(body.en), part(body.hi)].join('#')).digest('hex');
}

export const answerIndex = z.number().int().min(0).max(3);

/** Student-facing view of a frozen question: no answer and no explanation. */
export function publicQuestionView(snapshot: { type: string; body: QuestionBody; passage?: { en?: string; hi?: string } | null }) {
  const strip = (l?: LangBody) => {
    if (!l) return undefined;
    const rest = { ...l };
    delete rest.explanation; // the answer explanation must never reach a running attempt
    return rest;
  };
  return {
    type: snapshot.type,
    en: strip(snapshot.body.en),
    hi: strip(snapshot.body.hi),
    passage: snapshot.passage ?? null,
  };
}
