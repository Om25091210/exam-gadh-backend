import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AccessService } from '../../access/access.service';
import { Clock } from '../../common/clock';
import { ApiError, conflict, notFound } from '../../common/api-error';
import { istDateString, istDayStart } from '../../common/ist';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

export const page = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) };
export const caQuery = z.object({ ...page, category: z.enum(['CG', 'NAT']).optional(), topic: z.string().max(40).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), q: z.string().trim().min(2).max(80).optional() });
export const monthQuery = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });
export const materialQuery = z.object({ ...page, examId: z.string().max(40).optional(), subjectCode: z.string().max(40).optional(), kind: z.enum(['pdf', 'video', 'link']).optional() });
export const pyqQuery = z.object({ examId: z.string().max(40).optional(), year: z.coerce.number().int().min(1950).max(2100).optional() });

@Injectable()
export class StudentContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly clock: Clock,
    private readonly storage: StorageService,
  ) {}

  /** Published, and neither scheduled for later nor expired. */
  private live(now: Date) {
    return { status: 'published' as const, OR: [{ publishAt: null }, { publishAt: { lte: now } }] };
  }

  // ------------------------------------------------------------------ current affairs
  async ca(userId: string, q: z.infer<typeof caQuery>) {
    const now = this.clock.now();
    const where: Prisma.CurrentAffairWhereInput = {
      ...this.live(now),
      category: q.category,
      topicCode: q.topic,
      ...(q.date ? { date: new Date(q.date) } : q.from || q.to ? { date: { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } } : {}),
      ...(q.q ? { AND: [{ OR: [{ titleEn: { contains: q.q, mode: 'insensitive' } }, { titleHi: { contains: q.q, mode: 'insensitive' } }] }] } : {}),
    };
    const [total, rows, paid] = await Promise.all([
      this.prisma.currentAffair.count({ where }),
      this.prisma.currentAffair.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.access.hasPaidAccess(userId),
    ]);
    return { page: q.page, pageSize: q.pageSize, total, items: rows.map((r) => this.caView(r, paid, false)) };
  }

  private caView(r: Prisma.CurrentAffairGetPayload<object>, paid: boolean, full: boolean) {
    const locked = r.access === 'paid' && !paid;
    const base = { id: r.id, date: r.date.toISOString().slice(0, 10), category: r.category, titleEn: r.titleEn, titleHi: r.titleHi, topicCode: r.topicCode, tags: r.tags, access: r.access, locked, imageUrl: this.storage.publicUrl(r.imageKey) };
    if (locked) return base; // a paid item shows its headline only
    return { ...base, summaryEn: r.summaryEn, summaryHi: r.summaryHi, ...(full ? { angleEn: r.angleEn, angleHi: r.angleHi, sourceUrl: r.sourceUrl, quizTestId: r.quizTestId } : {}) };
  }

  async caItem(userId: string, id: string) {
    const r = await this.prisma.currentAffair.findFirst({ where: { id, ...this.live(this.clock.now()) } });
    if (!r) throw notFound('Current affair');
    return this.caView(r, await this.access.hasPaidAccess(userId), true);
  }

  /** A month's capsule, grouped by day (the "monthly compilation"). */
  async caMonth(userId: string, month: string) {
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const [rows, paid] = await Promise.all([
      this.prisma.currentAffair.findMany({ where: { ...this.live(this.clock.now()), date: { gte: start, lt: end } }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
      this.access.hasPaidAccess(userId),
    ]);
    const days = new Map<string, ReturnType<StudentContentService['caView']>[]>();
    for (const r of rows) {
      const k = r.date.toISOString().slice(0, 10);
      days.set(k, [...(days.get(k) ?? []), this.caView(r, paid, false)]);
    }
    return { month, total: rows.length, days: [...days.entries()].map(([date, items]) => ({ date, items })) };
  }

  // ------------------------------------------------------------------ updates, FAQs, interview
  async updates(examId?: string) {
    const now = this.clock.now();
    const today = istDayStart(istDateString(now));
    const [announcements, calendar] = await Promise.all([
      this.prisma.announcement.findMany({ where: { ...this.live(now), AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, { OR: [{ examId: null }, ...(examId ? [{ examId }] : [])] }] }, orderBy: [{ pinned: 'desc' }, { publishAt: 'desc' }, { createdAt: 'desc' }], take: 50 }),
      this.prisma.calendarEvent.findMany({ where: { date: { gte: today }, ...(examId ? { examId } : {}) }, orderBy: { date: 'asc' }, take: 50 }),
    ]);
    return {
      announcements: announcements.map((a) => ({ id: a.id, kind: a.kind, titleEn: a.titleEn, titleHi: a.titleHi, bodyEn: a.bodyEn, bodyHi: a.bodyHi, examId: a.examId, linkUrl: a.linkUrl, pinned: a.pinned, publishedAt: a.publishAt ?? a.createdAt })),
      calendar: calendar.map((c) => ({ id: c.id, examId: c.examId, stage: c.stage, labelEn: c.labelEn, labelHi: c.labelHi, date: c.date.toISOString().slice(0, 10), sourceUrl: c.sourceUrl })),
    };
  }

  async faqs(q?: string) {
    const where: Prisma.FaqWhereInput = q ? { OR: [{ keywords: { contains: q, mode: 'insensitive' } }, { qEn: { contains: q, mode: 'insensitive' } }, { qHi: { contains: q, mode: 'insensitive' } }] } : {};
    return this.prisma.faq.findMany({ where, orderBy: { qEn: 'asc' }, take: 50 });
  }

  interview(examId?: string, category?: string) {
    return this.prisma.interviewQuestion.findMany({ where: { examId, category }, orderBy: [{ category: 'asc' }, { qEn: 'asc' }], take: 200 });
  }

  // ------------------------------------------------------------------ study material
  async materials(userId: string, q: z.infer<typeof materialQuery>) {
    const where: Prisma.MaterialWhereInput = { ...this.live(this.clock.now()), examId: q.examId, subjectCode: q.subjectCode, kind: q.kind };
    const [total, rows, paid] = await Promise.all([this.prisma.material.count({ where }), this.prisma.material.findMany({ where, orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }), this.access.hasPaidAccess(userId)]);
    return { page: q.page, pageSize: q.pageSize, total, items: rows.map((m) => ({ id: m.id, titleEn: m.titleEn, titleHi: m.titleHi, kind: m.kind, subjectCode: m.subjectCode, topicCode: m.topicCode, examId: m.examId, access: m.access, locked: m.access === 'paid' && !paid })) };
  }

  /** Free material opens for everyone; paid material needs a plan. PDFs come as a 10-minute private link. */
  async material(userId: string, id: string) {
    const m = await this.prisma.material.findFirst({ where: { id, ...this.live(this.clock.now()) } });
    if (!m) throw notFound('Material');
    if (m.access === 'paid' && !(await this.access.hasPaidAccess(userId))) throw new ApiError(403, 'PAYMENT_REQUIRED', 'A paid plan is required for this material');
    return { id: m.id, titleEn: m.titleEn, titleHi: m.titleHi, kind: m.kind, url: m.kind === 'pdf' ? null : m.url, downloadUrl: m.kind === 'pdf' && m.fileKey ? await this.storage.presignDownload(m.fileKey, `${m.titleEn}.pdf`) : null };
  }

  // ------------------------------------------------------------------ previous years' papers
  async pyq(userId: string, q: z.infer<typeof pyqQuery>) {
    const tests = await this.prisma.test.findMany({ where: { kind: 'pyq', archived: false, ownerUserId: null, publishedVersionId: { not: null }, examId: q.examId, pyqYear: q.year }, orderBy: [{ pyqYear: 'desc' }, { titleEn: 'asc' }], include: { paper: { select: { code: true, nameEn: true, nameHi: true } } } });
    const paid = await this.access.hasPaidAccess(userId);
    const versions = new Map((await this.prisma.testVersion.findMany({ where: { id: { in: tests.map((t) => t.publishedVersionId!) } }, select: { id: true, questionCount: true, durationMin: true, maxScore: true } })).map((v) => [v.id, v]));
    const byYear = new Map<number | null, unknown[]>();
    for (const t of tests) {
      const v = versions.get(t.publishedVersionId!);
      byYear.set(t.pyqYear, [...(byYear.get(t.pyqYear) ?? []), { id: t.id, examId: t.examId, titleEn: t.titleEn, titleHi: t.titleHi, year: t.pyqYear, paper: t.paper, questionCount: v?.questionCount, durationMin: v?.durationMin, maxScore: v?.maxScore, access: t.access, locked: t.access === 'paid' && !paid }]);
    }
    return { years: [...byYear.entries()].map(([year, papers]) => ({ year, papers })) };
  }

  /** How many previous-year questions each topic has: tells a student where marks usually come from. */
  async pyqFrequency(examId?: string) {
    const rows = await this.prisma.question.groupBy({ by: ['topicCode'], where: { status: 'published', source: 'pyq', pyqExamId: examId }, _count: { _all: true }, orderBy: { _count: { topicCode: 'desc' } } });
    const topics = new Map((await this.prisma.topic.findMany({ where: { code: { in: rows.map((r) => r.topicCode) } } })).map((t) => [t.code, t]));
    const total = rows.reduce((n, r) => n + r._count._all, 0);
    return { total, topics: rows.map((r) => ({ topicCode: r.topicCode, nameEn: topics.get(r.topicCode)?.nameEn, nameHi: topics.get(r.topicCode)?.nameHi, questions: r._count._all, sharePct: total ? Math.round((r._count._all / total) * 1000) / 10 : 0 })) };
  }

  // ------------------------------------------------------------------ series and enrolment
  async seriesList(userId: string, examId?: string) {
    const [series, enrolled, paid] = await Promise.all([
      this.prisma.testSeries.findMany({ where: { status: 'published', examId }, orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }], include: { _count: { select: { items: true } } } }),
      this.prisma.enrollment.findMany({ where: { userId }, select: { seriesId: true } }),
      this.access.hasPaidAccess(userId),
    ]);
    const mine = new Set(enrolled.map((e) => e.seriesId));
    return series.map((s) => ({ id: s.id, examId: s.examId, titleEn: s.titleEn, titleHi: s.titleHi, descEn: s.descEn, descHi: s.descHi, access: s.access, tests: s._count.items, enrolled: mine.has(s.id), locked: s.access === 'paid' && !paid }));
  }

  async seriesDetail(userId: string, id: string) {
    const s = await this.prisma.testSeries.findFirst({ where: { id, status: 'published' }, include: { items: { orderBy: { position: 'asc' }, include: { test: true } } } });
    if (!s) throw notFound('Series');
    const tests = s.items.map((i) => i.test).filter((t) => !t.archived && t.publishedVersionId && !t.ownerUserId);
    const finished = await this.prisma.attemptResult.findMany({ where: { userId, version: { testId: { in: tests.map((t) => t.id) } } }, select: { score: true, maxScore: true, version: { select: { testId: true } } } });
    const bestPct = new Map<string, number>();
    for (const r of finished) bestPct.set(r.version.testId, Math.max(bestPct.get(r.version.testId) ?? -Infinity, r.maxScore ? Math.round((r.score / r.maxScore) * 1000) / 10 : 0));
    const [enrolled, paid] = await Promise.all([this.prisma.enrollment.findUnique({ where: { userId_seriesId: { userId, seriesId: id } } }), this.access.hasPaidAccess(userId)]);
    return {
      id: s.id, examId: s.examId, titleEn: s.titleEn, titleHi: s.titleHi, descEn: s.descEn, descHi: s.descHi, access: s.access, enrolled: !!enrolled, locked: s.access === 'paid' && !paid,
      progress: { total: tests.length, attempted: tests.filter((t) => bestPct.has(t.id)).length },
      tests: tests.map((t) => ({ id: t.id, titleEn: t.titleEn, titleHi: t.titleHi, kind: t.kind, mode: t.mode, access: t.access, locked: t.access === 'paid' && !paid, bestPct: bestPct.get(t.id) ?? null })),
    };
  }

  async enroll(userId: string, id: string) {
    const s = await this.prisma.testSeries.findFirst({ where: { id, status: 'published' } });
    if (!s) throw notFound('Series');
    if (s.access === 'paid' && !(await this.access.hasPaidAccess(userId, s.examId))) throw new ApiError(403, 'PAYMENT_REQUIRED', 'A paid plan is required for this series');
    const existing = await this.prisma.enrollment.findUnique({ where: { userId_seriesId: { userId, seriesId: id } } });
    if (existing) throw conflict('ALREADY_ENROLLED', 'You are already enrolled');
    return this.prisma.enrollment.create({ data: { userId, seriesId: id, source: s.access === 'free' ? 'free' : 'entitlement' } });
  }

  async unenroll(userId: string, id: string) {
    const r = await this.prisma.enrollment.deleteMany({ where: { userId, seriesId: id } });
    if (r.count === 0) throw notFound('Enrollment');
  }

  // ------------------------------------------------------------------ daily quiz
  async dailyQuiz(userId: string) {
    const today = istDateString(this.clock.now());
    const dq = await this.prisma.dailyQuiz.findUnique({ where: { date: new Date(today) } });
    if (!dq) return { date: today, available: false };
    const test = await this.prisma.test.findFirst({ where: { id: dq.testId, archived: false, publishedVersionId: { not: null } } });
    if (!test) return { date: today, available: false };
    const [v, mine] = await Promise.all([
      this.prisma.testVersion.findUniqueOrThrow({ where: { id: test.publishedVersionId! }, select: { questionCount: true, durationMin: true, maxScore: true } }),
      this.prisma.attemptResult.findFirst({ where: { userId, version: { testId: test.id } }, orderBy: { submittedAt: 'desc' }, select: { attemptId: true, score: true, maxScore: true } }),
    ]);
    return { date: today, available: true, test: { id: test.id, titleEn: test.titleEn, titleHi: test.titleHi, ...v }, done: !!mine, result: mine };
  }
}
