import { z } from 'zod';
import { sanitizeRichText } from '../../common/rich-text';
import { code } from '../../common/zod';

const rich = (max: number) => z.string().transform(sanitizeRichText).pipe(z.string().min(1).max(max));
const optRich = (max: number) => rich(max).nullable().optional();
const url = z.string().url().max(500).refine((u) => /^https:\/\//i.test(u), { message: 'must be an https:// link' });
const date = z.coerce.date();
const status = z.enum(['draft', 'in_review', 'published', 'archived']);
const access = z.enum(['free', 'paid']);
const s3key = (prefix: string) => z.string().regex(new RegExp(`^${prefix}/[A-Za-z0-9/_.-]{3,200}$`), `must be an uploaded file under ${prefix}/`);

export const materialSchema = z
  .object({
    titleEn: rich(200),
    titleHi: rich(200),
    kind: z.enum(['pdf', 'video', 'link']),
    subjectCode: code.nullable().optional(),
    topicCode: code.nullable().optional(),
    examId: code.nullable().optional(),
    fileKey: s3key('materials').nullable().optional(),
    url: url.nullable().optional(),
    access: access.default('free'),
    status: status.default('draft'),
    publishAt: date.nullable().optional(),
    sort: z.number().int().default(0),
  })
  .superRefine((m, ctx) => {
    if (m.kind === 'pdf' && !m.fileKey) ctx.addIssue({ code: 'custom', path: ['fileKey'], message: 'a PDF needs an uploaded file' });
    if (m.kind !== 'pdf' && !m.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'a video or link needs its https:// address' });
  });

export const currentAffairSchema = z.object({
  date,
  category: z.enum(['CG', 'NAT']),
  titleEn: rich(300),
  titleHi: rich(300),
  summaryEn: rich(4000),
  summaryHi: rich(4000),
  angleEn: optRich(1500),
  angleHi: optRich(1500),
  topicCode: code.nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  sourceUrl: url.nullable().optional(),
  imageKey: s3key('public/ca-images').nullable().optional(),
  quizTestId: z.string().uuid().nullable().optional(),
  access: access.default('free'),
  status: status.default('draft'),
  publishAt: date.nullable().optional(),
});

export const announcementSchema = z
  .object({
    kind: z.enum(['update', 'banner', 'alert']).default('update'),
    titleEn: rich(200),
    titleHi: rich(200),
    bodyEn: rich(2000),
    bodyHi: rich(2000),
    examId: code.nullable().optional(),
    linkUrl: url.nullable().optional(),
    pinned: z.boolean().default(false),
    status: status.default('draft'),
    publishAt: date.nullable().optional(),
    expiresAt: date.nullable().optional(),
  })
  .refine((a) => !a.publishAt || !a.expiresAt || a.expiresAt > a.publishAt, { path: ['expiresAt'], message: 'must be after the publish time' });

export const calendarSchema = z.object({ examId: code, stage: z.enum(['prelims', 'mains', 'interview']).default('prelims'), labelEn: rich(200), labelHi: rich(200), date, sourceUrl: url.nullable().optional() });
export const faqSchema = z.object({ keywords: z.string().trim().min(2).max(300), qEn: rich(300), qHi: rich(300), aEn: rich(2000), aHi: rich(2000) });
export const interviewSchema = z.object({ examId: code, category: z.string().trim().min(2).max(40), qEn: rich(500), qHi: rich(500), pointsEn: rich(1500), pointsHi: rich(1500) });
export const cannedSchema = z.object({ title: z.string().trim().min(2).max(80), bodyEn: rich(1500), bodyHi: rich(1500) });
export const templateSchema = z.object({ key: z.string().trim().regex(/^[a-z][a-z0-9_.]{2,40}$/, 'lower-case letters, digits, _ and .'), titleEn: rich(120), titleHi: rich(120), bodyEn: rich(500), bodyHi: rich(500) });

const block = z.object({ t: z.enum(['p', 'li', 'h']), x: rich(3000) });
const lang = z.object({ title: rich(200), blocks: z.array(block).min(1).max(300) });
const section = z.object({ anchor: z.string().regex(/^[a-z0-9_-]{1,40}$/, 'lower-case letters, digits, _ and -'), en: lang.optional(), hi: lang.optional() }).refine((s) => s.en || s.hi, { message: 'write the section in at least one language' });
export const noteSchema = z
  .object({
    id: code.transform((s) => s.toLowerCase()),
    subjectCode: code,
    titleEn: rich(200),
    titleHi: rich(200),
    access: access.default('free'),
    sections: z.array(section).min(1).max(100),
    published: z.boolean().default(false),
  })
  .refine((n) => new Set(n.sections.map((s) => s.anchor)).size === n.sections.length, { path: ['sections'], message: 'section anchors must be unique' });
