import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../prisma/prisma.service';
import { displayName } from '../attempts/results.service';
import { publishTestVersion } from '../tests/test-publishing';
import { sanitizeRichText } from '../../common/rich-text';

export const questionRef = z.object({ attemptId: z.string().uuid(), qid: z.string().uuid() });
export const bookmarkBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), attemptId: z.string().uuid(), qid: z.string().uuid() }),
  z.object({ kind: z.literal('material'), refId: z.string().uuid() }),
  z.object({ kind: z.literal('current_affair'), refId: z.string().uuid() }),
]);
export const noteBody = questionRef.extend({ text: z.string().trim().min(1).max(2000) });
export const reportBody = questionRef.extend({ reason: z.enum(['wrong_answer', 'typo', 'unclear', 'translation', 'other']), note: z.string().trim().max(1000).optional() });
export const practiceBody = z.discriminatedUnion('source', [
  z.object({ source: z.literal('topic'), topicCode: z.string().min(1).max(60), count: z.number().int().min(5).max(30).default(10) }),
  z.object({ source: z.literal('revision'), count: z.number().int().min(5).max(30).default(10) }),
]);
export const periodQuery = z.object({ period: z.enum(['week', 'month', 'all']).default('week'), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const revisionQuery = z.object({ topicCode: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

const DAILY_PRACTICE_SETS = 10;

@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Resolves a question the student has seen in a finished attempt of their own. Throws 404 otherwise. */
  private async resolveQuestion(userId: string, ref: { attemptId: string; qid: string }) {
    const attempt = await this.prisma.attempt.findFirst({ where: { id: ref.attemptId, userId, status: { not: 'in_progress' } } });
    if (!attempt || !attempt.questionOrder.includes(ref.qid)) throw notFound('Question');
    const tvq = await this.prisma.testVersionQuestion.findUnique({ where: { id: ref.qid } });
    if (!tvq) throw notFound('Question');
    return tvq.questionId;
  }

  /** Question ids whose answer key this student may see: they finished an attempt whose result is released. */
  private async revealableQuestionIds(userId: string, questionIds: string[]) {
    if (!questionIds.length) return new Set<string>();
    const now = this.clock.now();
    const rows = await this.prisma.$queryRaw<Array<{ questionId: string }>>`
      SELECT DISTINCT t."questionId" FROM "TestVersionQuestion" t
      JOIN "Attempt" a ON a."testVersionId" = t."versionId" AND a."userId" = ${userId}::uuid AND a.status <> 'in_progress' AND t.id = ANY(a."questionOrder"::uuid[])
      JOIN "TestVersion" v ON v.id = t."versionId" AND (v."resultReleaseAt" IS NULL OR v."resultReleaseAt" <= ${now})
      WHERE t."questionId" = ANY(${questionIds}::uuid[])`;
    return new Set(rows.map((r) => r.questionId));
  }

  private async questionCards(userId: string, questionIds: string[]) {
    const [qs, reveal] = await Promise.all([this.prisma.question.findMany({ where: { id: { in: questionIds } }, include: { passage: true } }), this.revealableQuestionIds(userId, questionIds)]);
    const byId = new Map(qs.map((q) => [q.id, q]));
    return questionIds.flatMap((id) => {
      const q = byId.get(id);
      if (!q) return [];
      const body = q.body as { en?: Record<string, unknown>; hi?: Record<string, unknown> };
      const strip = (l?: Record<string, unknown>) => (l && !reveal.has(id) ? Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'explanation')) : l);
      return [{ questionId: id, type: q.type, topicCode: q.topicCode, en: strip(body.en), hi: strip(body.hi), correctOption: reveal.has(id) ? q.answer : null }];
    });
  }

  // ------------------------------------------------------------------ bookmarks
  async addBookmark(userId: string, b: z.infer<typeof bookmarkBody>) {
    let refId: string;
    if (b.kind === 'question') refId = await this.resolveQuestion(userId, b);
    else if (b.kind === 'material') {
      if (!(await this.prisma.material.findFirst({ where: { id: b.refId, status: 'published' } }))) throw notFound('Material');
      refId = b.refId;
    } else {
      if (!(await this.prisma.currentAffair.findFirst({ where: { id: b.refId, status: 'published' } }))) throw notFound('Current affair');
      refId = b.refId;
    }
    await this.prisma.bookmark.upsert({ where: { userId_kind_refId: { userId, kind: b.kind, refId } }, update: {}, create: { userId, kind: b.kind, refId } });
    return { kind: b.kind, refId };
  }

  async removeBookmark(userId: string, kind: string, refId: string) {
    await this.prisma.bookmark.deleteMany({ where: { userId, kind, refId } });
  }

  async bookmarks(userId: string, kind?: string) {
    const rows = await this.prisma.bookmark.findMany({ where: { userId, kind }, orderBy: { createdAt: 'desc' }, take: 200 });
    const ids = (k: string) => rows.filter((r) => r.kind === k).map((r) => r.refId);
    const [cards, materials, cas] = await Promise.all([
      this.questionCards(userId, ids('question')),
      this.prisma.material.findMany({ where: { id: { in: ids('material') } }, select: { id: true, titleEn: true, titleHi: true, kind: true } }),
      this.prisma.currentAffair.findMany({ where: { id: { in: ids('current_affair') } }, select: { id: true, titleEn: true, titleHi: true, date: true } }),
    ]);
    return { questions: cards, materials, currentAffairs: cas };
  }

  // ------------------------------------------------------------------ notes + reports
  async saveNote(userId: string, b: z.infer<typeof noteBody>) {
    const questionId = await this.resolveQuestion(userId, b);
    const text = sanitizeRichText(b.text);
    const n = await this.prisma.userNote.upsert({ where: { userId_questionId: { userId, questionId } }, update: { text }, create: { userId, questionId, text } });
    return { questionId, text: n.text, updatedAt: n.updatedAt };
  }

  async notes(userId: string) {
    const notes = await this.prisma.userNote.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, take: 200 });
    const cards = new Map((await this.questionCards(userId, notes.map((n) => n.questionId))).map((c) => [c.questionId, c]));
    return notes.map((n) => ({ questionId: n.questionId, text: n.text, updatedAt: n.updatedAt, question: cards.get(n.questionId) ?? null }));
  }

  async deleteNote(userId: string, questionId: string) {
    await this.prisma.userNote.deleteMany({ where: { userId, questionId } });
  }

  async report(userId: string, b: z.infer<typeof reportBody>) {
    const questionId = await this.resolveQuestion(userId, b);
    const dup = await this.prisma.questionReport.findFirst({ where: { userId, questionId, status: 'open' } });
    if (dup) throw conflict('ALREADY_REPORTED', 'You have already reported this question; the team is looking at it');
    const note = b.note ? sanitizeRichText(b.note) : null;
    await this.prisma.$transaction([
      this.prisma.questionReport.create({ data: { userId, questionId, reason: b.reason, note } }),
      this.prisma.question.update({ where: { id: questionId }, data: { reportedCount: { increment: 1 } } }),
    ]);
    return { reported: true };
  }

  // ------------------------------------------------------------------ revision + practice
  /** Questions the student answered wrongly in released results, newest first, one row per question. */
  private async wrongQuestionIds(userId: string, limit: number, topicCode?: string): Promise<string[]> {
    const now = this.clock.now();
    const rows = await this.prisma.$queryRaw<Array<{ questionId: string }>>`
      SELECT t."questionId", max(at."submittedAt") AS last_at
      FROM "AttemptAnswer" a
      JOIN "Attempt" at ON at.id = a."attemptId" AND at."userId" = ${userId}::uuid AND at.status <> 'in_progress'
      JOIN "TestVersion" v ON v.id = at."testVersionId" AND (v."resultReleaseAt" IS NULL OR v."resultReleaseAt" <= ${now})
      JOIN "TestVersionQuestion" t ON t.id = a."tvqId"
      WHERE a.selected IS NOT NULL AND a.selected <> (t.snapshot->>'answer')::int
        AND (${topicCode ?? null}::text IS NULL OR t.snapshot->>'topicCode' = ${topicCode ?? null})
      GROUP BY t."questionId" ORDER BY last_at DESC LIMIT ${limit}`;
    return rows.map((r) => r.questionId);
  }

  async revision(userId: string, q: z.infer<typeof revisionQuery>) {
    const wrong = await this.wrongQuestionIds(userId, q.limit, q.topicCode);
    const marked = q.topicCode ? [] : (await this.prisma.bookmark.findMany({ where: { userId, kind: 'question' }, orderBy: { createdAt: 'desc' }, take: q.limit })).map((b) => b.refId);
    const ids = [...new Set([...wrong, ...marked])].slice(0, q.limit);
    const cards = await this.questionCards(userId, ids);
    const wrongSet = new Set(wrong);
    const markedSet = new Set(marked);
    return { total: cards.length, questions: cards.map((c) => ({ ...c, reasons: [wrongSet.has(c.questionId) && 'wrong', markedSet.has(c.questionId) && 'bookmarked'].filter(Boolean) })) };
  }

  /** Builds a personal practice test (private to the student, never in the catalog) and publishes its frozen version. */
  async createPractice(userId: string, b: z.infer<typeof practiceBody>) {
    const since = new Date(this.clock.now().getTime() - 86_400_000);
    if ((await this.prisma.test.count({ where: { ownerUserId: userId, createdAt: { gte: since } } })) >= DAILY_PRACTICE_SETS) throw conflict('PRACTICE_LIMIT', `You can create up to ${DAILY_PRACTICE_SETS} practice sets a day`);
    let questionIds: string[];
    let topicCode: string | null = null;
    if (b.source === 'topic') {
      if (!(await this.prisma.topic.findUnique({ where: { code: b.topicCode } }))) throw badRequest('UNKNOWN_TOPIC', 'Unknown topic');
      topicCode = b.topicCode;
      const wrong = await this.wrongQuestionIds(userId, b.count, b.topicCode);
      const pool = await this.prisma.question.findMany({ where: { topicCode: b.topicCode, status: 'published', type: 'single' }, select: { id: true } });
      const rest = shuffle(pool.map((p) => p.id).filter((id) => !wrong.includes(id)));
      questionIds = [...wrong.filter((id) => pool.some((p) => p.id === id)), ...rest].slice(0, b.count);
    } else {
      const wrong = await this.wrongQuestionIds(userId, b.count);
      const marked = (await this.prisma.bookmark.findMany({ where: { userId, kind: 'question' }, take: b.count })).map((x) => x.refId);
      const live = new Set((await this.prisma.question.findMany({ where: { id: { in: [...wrong, ...marked] }, status: 'published', type: 'single' }, select: { id: true } })).map((x) => x.id));
      questionIds = [...new Set([...wrong, ...marked])].filter((id) => live.has(id)).slice(0, b.count);
    }
    if (questionIds.length < 3) throw conflict('NOT_ENOUGH_QUESTIONS', 'Not enough questions yet to build a practice set. Take a test first.');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const exam = (user.targetExam && (await this.prisma.exam.findUnique({ where: { id: user.targetExam } }))) || (await this.prisma.exam.findFirst({ orderBy: { id: 'asc' } }));
    if (!exam) throw conflict('NO_EXAM', 'No exam is configured yet');
    const topic = topicCode ? await this.prisma.topic.findUnique({ where: { code: topicCode } }) : null;
    return this.prisma.$transaction(async (tx) => {
      const test = await tx.test.create({
        data: {
          examId: exam.id, kind: 'topic', mode: 'static', access: 'free', topicCode, ownerUserId: userId,
          titleEn: topic ? `Practice: ${topic.nameEn}` : 'Practice: revision set',
          titleHi: topic ? `अभ्यास: ${topic.nameHi}` : 'अभ्यास: पुनरावृत्ति सेट',
        },
      });
      const version = await tx.testVersion.create({
        data: {
          testId: test.id, version: 1, durationMin: Math.max(5, questionIds.length), correctMarks: 1, negativeFraction: 0.25,
          countsTowardMerit: false, shuffleQuestions: true,
          questions: { create: questionIds.map((questionId, i) => ({ questionId, questionVersion: 0, position: i + 1 })) },
        } as Prisma.TestVersionUncheckedCreateInput,
      });
      await publishTestVersion(tx, version.id);
      return { testId: test.id, questions: questionIds.length, durationMin: Math.max(5, questionIds.length) };
    });
  }

  // ------------------------------------------------------------------ overall leaderboard
  async overallLeaderboard(userId: string, q: z.infer<typeof periodQuery>) {
    const now = this.clock.now();
    const days = q.period === 'week' ? 7 : q.period === 'month' ? 30 : 36500;
    const since = new Date(now.getTime() - days * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ userId: string; score: number; tests: bigint; time: bigint; rk: bigint; name: string; avatarUrl: string | null; show: boolean }>>`
      WITH agg AS (
        SELECT r."userId", sum(r.score) AS score, count(*) AS tests, sum(r."timeSpentSec") AS time
        FROM "AttemptResult" r JOIN "TestVersion" v ON v.id = r."testVersionId" JOIN "Test" t ON t.id = v."testId"
        WHERE r."isRanked" AND t."ownerUserId" IS NULL AND r."submittedAt" >= ${since} AND (v."resultReleaseAt" IS NULL OR v."resultReleaseAt" <= ${now})
        GROUP BY r."userId"),
      ranked AS (SELECT agg.*, rank() OVER (ORDER BY score DESC, time ASC) AS rk FROM agg)
      SELECT ranked.*, u.name, u."avatarUrl", u."showOnLeaderboard" AS show FROM ranked JOIN "User" u ON u.id = ranked."userId"
      WHERE ranked.rk <= ${q.limit * 2} OR ranked."userId" = ${userId}::uuid ORDER BY ranked.rk, ranked."userId"`;
    const total = rows.length ? Number((await this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(DISTINCT r."userId") AS n FROM "AttemptResult" r JOIN "TestVersion" v ON v.id = r."testVersionId" JOIN "Test" t ON t.id = v."testId" WHERE r."isRanked" AND t."ownerUserId" IS NULL AND r."submittedAt" >= ${since} AND (v."resultReleaseAt" IS NULL OR v."resultReleaseAt" <= ${now})`)[0].n) : 0;
    const shape = (r: (typeof rows)[number]) => ({ rank: Number(r.rk), name: displayName(r.name), avatarUrl: r.avatarUrl, score: Math.round(r.score * 100) / 100, tests: Number(r.tests), timeSpentSec: Number(r.time), isMe: r.userId === userId });
    // Hidden profiles keep their rank internally; they are just not listed (except to themselves).
    const entries = rows.filter((r) => r.show || r.userId === userId).filter((r) => Number(r.rk) <= q.limit * 2).slice(0, q.limit).map(shape);
    const mine = rows.find((r) => r.userId === userId);
    return { period: q.period, total, entries, me: mine ? shape(mine) : null };
  }

  // ------------------------------------------------------------------ purchases
  async orders(userId: string) {
    const orders = await this.prisma.order.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100, include: { plan: { select: { nameEn: true, nameHi: true } }, payments: { select: { status: true, method: true, createdAt: true } } } });
    const invoices = new Map((await this.prisma.invoice.findMany({ where: { orderId: { in: orders.map((o) => o.id) } } })).map((i) => [i.orderId, i]));
    return orders.map((o) => ({ id: o.id, planId: o.planId, planNameEn: o.plan.nameEn, planNameHi: o.plan.nameHi, months: o.months, amountPaise: o.amountPaise, currency: o.currency, status: o.status, couponCode: o.couponCode, createdAt: o.createdAt, paymentStatus: o.payments[0]?.status ?? null, invoiceNumber: invoices.get(o.id)?.number ?? null }));
  }

  async receipt(userId: string, orderId: string) {
    const o = await this.prisma.order.findFirst({ where: { id: orderId, userId }, include: { plan: true, payments: true, user: { select: { name: true, email: true } } } });
    const inv = o && (await this.prisma.invoice.findUnique({ where: { orderId: o.id } }));
    if (!o || !inv) throw notFound('Receipt');
    const pay = o.payments.find((p) => p.status === 'captured' || p.status === 'refunded');
    return { number: inv.number, issuedAt: inv.issuedAt, customer: { name: o.user.name, email: o.user.email }, plan: { id: o.planId, nameEn: o.plan.nameEn, nameHi: o.plan.nameHi }, months: o.months, amountPaise: o.amountPaise, currency: o.currency, couponCode: o.couponCode, paymentId: pay?.razorpayPaymentId ?? null, method: pay?.method ?? null, status: o.status };
  }
}

function shuffle<T>(a: T[]): T[] {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}
