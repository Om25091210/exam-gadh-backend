import { z } from 'zod';
import { code } from '../../common/zod';

const text = (max = 200) => z.string().trim().min(1).max(max);

export const examSchema = z.object({
  id: code.transform((s) => s.toLowerCase()),
  nameEn: text(),
  nameHi: text(),
  shortEn: text(40),
  shortHi: text(40),
  hasMains: z.boolean().default(false),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
});
export const examPatch = examSchema.omit({ id: true }).partial();

export const paperSchema = z
  .object({
    code: code.transform((s) => s.toUpperCase()),
    stage: z.enum(['prelims', 'mains', 'interview']).default('prelims'),
    nameEn: text(),
    nameHi: text(),
    questionCount: z.number().int().min(1).max(500),
    totalMarks: z.number().positive().max(5000),
    durationMin: z.number().int().min(1).max(600),
    correctMarks: z.number().positive().max(100),
    negativeFraction: z.number().min(0).max(1),
    qualifyingPct: z.number().min(0).max(100).nullable().default(null),
    qualifyingPctReserved: z.number().min(0).max(100).nullable().default(null),
    countsTowardMerit: z.boolean().default(true),
    sort: z.number().int().default(0),
    active: z.boolean().default(true),
  })
  .superRefine((p, ctx) => {
    if (p.qualifyingPctReserved != null && p.qualifyingPct == null) ctx.addIssue({ code: 'custom', path: ['qualifyingPct'], message: 'set the general cut-off too' });
    if (p.qualifyingPctReserved != null && p.qualifyingPct != null && p.qualifyingPctReserved > p.qualifyingPct) {
      ctx.addIssue({ code: 'custom', path: ['qualifyingPctReserved'], message: 'reserved cut-off cannot be higher than the general cut-off' });
    }
    if (p.qualifyingPct != null && p.countsTowardMerit) ctx.addIssue({ code: 'custom', path: ['countsTowardMerit'], message: 'a qualifying-only paper does not count toward merit' });
  });

export const verifySchema = z.object({ sourceUrl: z.string().url().max(500), note: z.string().trim().max(500).optional() });

export const subjectSchema = z.object({ code, nameEn: text(), nameHi: text(), sort: z.number().int().default(0) });
export const subjectPatch = subjectSchema.omit({ code: true }).partial();
export const topicSchema = z.object({ code, subjectCode: code, nameEn: text(), nameHi: text(), sort: z.number().int().default(0), weight: z.number().positive().max(10).default(1) });
export const topicPatch = topicSchema.omit({ code: true }).partial();
export const subtopicSchema = z.object({ code, topicCode: code, nameEn: text(), nameHi: text(), sort: z.number().int().default(0) });
export const subtopicPatch = subtopicSchema.omit({ code: true }).partial();
export const paperSubjects = z.object({ subjectCodes: z.array(code).max(50) });
