import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../common/api-error';
import { Clock } from '../../common/clock';
import { istDateString, istDayStart } from '../../common/ist';
import { sanitizeRichText } from '../../common/rich-text';
import { pageQuery, skipTake } from '../../common/zod';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';

const HOUR = 3_600_000;

const attachments = z.array(z.string().max(200)).max(3).default([]);
export const createDoubt = z.object({
  contextType: z.enum(['question', 'note', 'current_affair', 'free']).default('free'),
  contextId: z.string().max(80).optional(),
  examId: z.string().max(40).optional(),
  topicCode: z.string().max(60).optional(),
  text: z.string().trim().min(5).max(2000),
  attachmentKeys: attachments,
});
export const followUp = z.object({ text: z.string().trim().min(1).max(2000), attachmentKeys: attachments });
export const rateDoubt = z.object({ rating: z.number().int().min(1).max(5) });
export const similarQuery = z.object({ q: z.string().trim().min(3).max(200) });
export const uploadBody = z.object({ purpose: z.enum(['doubt-image', 'doubt-audio']), contentType: z.string().max(100) });
export const myDoubtsQuery = z.object({ ...pageQuery, status: z.enum(['open', 'answered', 'closed']).optional() });

export const adminDoubtsQuery = z.object({
  ...pageQuery,
  status: z.enum(['open', 'answered', 'closed']).optional(),
  /** overdue = still open and past its SLA; due_soon = open and due within 6 hours */
  sla: z.enum(['overdue', 'due_soon']).optional(),
  abuse: z.enum(['true', 'false']).optional(),
  q: z.string().trim().min(2).max(80).optional(),
});
export const staffReply = z.object({ text: z.string().trim().min(1).max(4000), close: z.boolean().default(false) });
export const abuseBody = z.object({ abuse: z.boolean() });
export const statsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round(((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) / HOUR) * 10) / 10;
};

@Injectable()
export class DoubtsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ student
  /** Answered FAQs that match the typed words; shown before the student submits (FR-060). */
  async similar(q: z.infer<typeof similarQuery>) {
    const words = q.q.toLowerCase().split(/\s+/).filter((w) => w.length >= 3).slice(0, 6);
    if (!words.length) return [];
    const rows = await this.prisma.faq.findMany({
      where: { OR: words.flatMap((w) => [{ keywords: { contains: w, mode: 'insensitive' as const } }, { qEn: { contains: w, mode: 'insensitive' as const } }, { qHi: { contains: w } }]) },
      take: 30,
    });
    const score = (f: (typeof rows)[number]) => words.filter((w) => `${f.keywords} ${f.qEn} ${f.qHi}`.toLowerCase().includes(w)).length;
    return rows.sort((a, b) => score(b) - score(a)).slice(0, 3).map((f) => ({ id: f.id, qEn: f.qEn, qHi: f.qHi, aEn: f.aEn, aHi: f.aHi }));
  }

  presignUpload(userId: string, b: z.infer<typeof uploadBody>) {
    return this.storage.presignUpload(b.purpose, b.contentType, userId);
  }

  /** Attachments must be files this student uploaded for doubts; nobody can attach another student's file. */
  private checkKeys(userId: string, keys: string[]) {
    for (const k of keys) {
      if (!k.startsWith(`doubts/${userId}/`) || k.includes('..')) throw badRequest('INVALID_ATTACHMENT', 'Attachment was not uploaded by you');
    }
  }

  async quota(userId: string) {
    const now = this.clock.now();
    const [daily, freeMonthly, paid] = await Promise.all([this.settings.get('doubts.dailyQuota'), this.settings.get('doubts.freeMonthly'), this.hasPaidAccess(userId)]);
    const today = istDayStart(istDateString(now));
    const monthStart = istDayStart(`${istDateString(now).slice(0, 7)}-01`);
    const [usedToday, usedMonth] = await Promise.all([
      this.prisma.doubt.count({ where: { userId, createdAt: { gte: today } } }),
      this.prisma.doubt.count({ where: { userId, createdAt: { gte: monthStart } } }),
    ]);
    return { paid, daily: { limit: daily, used: usedToday }, monthly: paid ? null : { limit: freeMonthly, used: usedMonth } };
  }

  private async hasPaidAccess(userId: string) {
    return (await this.prisma.entitlement.count({ where: { userId, revokedAt: null, endsAt: { gt: this.clock.now() } } })) > 0;
  }

  async create(userId: string, b: z.infer<typeof createDoubt>) {
    this.checkKeys(userId, b.attachmentKeys);
    if (b.contextType === 'question') {
      if (!b.contextId || !z.string().uuid().safeParse(b.contextId).success || !(await this.prisma.question.findUnique({ where: { id: b.contextId } }))) throw badRequest('INVALID_CONTEXT', 'Unknown question');
    } else if (b.contextType === 'current_affair') {
      if (!b.contextId || !z.string().uuid().safeParse(b.contextId).success || !(await this.prisma.currentAffair.findUnique({ where: { id: b.contextId } }))) throw badRequest('INVALID_CONTEXT', 'Unknown current affair');
    }
    const q = await this.quota(userId);
    if (q.daily.used >= q.daily.limit) throw new ApiError(429, 'DOUBT_DAILY_QUOTA', `You can ask ${q.daily.limit} doubts a day. Try again tomorrow.`, q);
    if (q.monthly && q.monthly.used >= q.monthly.limit) throw forbidden('DOUBT_FREE_QUOTA', `Free students can ask ${q.monthly.limit} doubts a month. Get a plan to ask more.`);
    const now = this.clock.now();
    const sla = await this.settings.get('doubts.slaHours');
    const text = sanitizeRichText(b.text);
    const d = await this.prisma.doubt.create({
      data: {
        userId, contextType: b.contextType, contextId: b.contextId, examId: b.examId, topicCode: b.topicCode,
        slaDueAt: new Date(now.getTime() + sla * HOUR), createdAt: now,
        messages: { create: { authorType: 'student', authorId: userId, text, attachmentKeys: b.attachmentKeys, createdAt: now } },
      },
    });
    return { id: d.id, status: d.status, slaDueAt: d.slaDueAt };
  }

  async list(userId: string, q: z.infer<typeof myDoubtsQuery>) {
    const where: Prisma.DoubtWhereInput = { userId, status: q.status };
    const [rows, total] = await Promise.all([
      this.prisma.doubt.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q), include: { messages: { orderBy: { createdAt: 'asc' }, take: 1 }, _count: { select: { messages: true } } } }),
      this.prisma.doubt.count({ where }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((d) => ({ id: d.id, status: d.status, contextType: d.contextType, topicCode: d.topicCode, preview: d.messages[0]?.text.slice(0, 120) ?? '', messages: d._count.messages, rating: d.rating, slaDueAt: d.slaDueAt, answeredAt: d.answeredAt, createdAt: d.createdAt })) };
  }

  private async mine(userId: string, id: string) {
    const d = await this.prisma.doubt.findFirst({ where: { id, userId }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
    if (!d) throw notFound('Doubt');
    return d;
  }

  private async thread(d: Awaited<ReturnType<DoubtsService['mine']>>) {
    return {
      id: d.id, status: d.status, contextType: d.contextType, contextId: d.contextId, topicCode: d.topicCode, rating: d.rating, reopened: d.reopened,
      slaDueAt: d.slaDueAt, firstResponseAt: d.firstResponseAt, answeredAt: d.answeredAt, createdAt: d.createdAt,
      messages: await Promise.all(d.messages.map(async (m) => ({ id: m.id, from: m.authorType, text: m.text, createdAt: m.createdAt, attachments: await Promise.all(m.attachmentKeys.map(async (k) => ({ key: k, url: await this.storage.presignDownload(k) }))) }))),
    };
  }

  async get(userId: string, id: string) {
    return this.thread(await this.mine(userId, id));
  }

  /** A follow-up on an answered doubt reopens it and restarts the SLA; a closed doubt is final. */
  async reply(userId: string, id: string, b: z.infer<typeof followUp>) {
    this.checkKeys(userId, b.attachmentKeys);
    const d = await this.mine(userId, id);
    if (d.status === 'closed') throw conflict('DOUBT_CLOSED', 'This doubt is closed. Ask a new one.');
    const now = this.clock.now();
    const sla = await this.settings.get('doubts.slaHours');
    await this.prisma.$transaction([
      this.prisma.doubtMessage.create({ data: { doubtId: id, authorType: 'student', authorId: userId, text: sanitizeRichText(b.text), attachmentKeys: b.attachmentKeys, createdAt: now } }),
      ...(d.status === 'answered' ? [this.prisma.doubt.update({ where: { id }, data: { status: 'open', reopened: true, slaDueAt: new Date(now.getTime() + sla * HOUR), answeredAt: null } })] : []),
    ]);
    return this.get(userId, id);
  }

  async rate(userId: string, id: string, rating: number) {
    const d = await this.mine(userId, id);
    if (d.status === 'open' && !d.firstResponseAt) throw conflict('NOT_ANSWERED', 'You can rate a doubt after it has been answered');
    await this.prisma.doubt.update({ where: { id }, data: { rating } });
  }

  async closeMine(userId: string, id: string) {
    const d = await this.mine(userId, id);
    if (d.status !== 'closed') await this.prisma.doubt.update({ where: { id }, data: { status: 'closed' } });
  }

  // ------------------------------------------------------------------ staff
  async adminList(q: z.infer<typeof adminDoubtsQuery>) {
    const now = this.clock.now();
    const where: Prisma.DoubtWhereInput = {
      status: q.status,
      abuse: q.abuse === undefined ? undefined : q.abuse === 'true',
      ...(q.sla === 'overdue' ? { status: 'open', slaDueAt: { lt: now } } : {}),
      ...(q.sla === 'due_soon' ? { status: 'open', slaDueAt: { gte: now, lt: new Date(now.getTime() + 6 * HOUR) } } : {}),
      ...(q.q ? { OR: [{ messages: { some: { text: { contains: q.q, mode: 'insensitive' } } } }, { user: { name: { contains: q.q, mode: 'insensitive' } } }, { user: { email: { contains: q.q, mode: 'insensitive' } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.doubt.findMany({ where, orderBy: [{ slaDueAt: 'asc' }], ...skipTake(q), include: { user: { select: { id: true, name: true, email: true } }, messages: { orderBy: { createdAt: 'asc' }, take: 1 } } }),
      this.prisma.doubt.count({ where }),
    ]);
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((d) => ({ id: d.id, status: d.status, student: d.user, contextType: d.contextType, topicCode: d.topicCode, preview: d.messages[0]?.text.slice(0, 120) ?? '', slaDueAt: d.slaDueAt, overdue: d.status === 'open' && d.slaDueAt < now, abuse: d.abuse, reopened: d.reopened, rating: d.rating, createdAt: d.createdAt })) };
  }

  async adminGet(id: string) {
    const d = await this.prisma.doubt.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } }, user: { select: { id: true, name: true, email: true, targetExam: true } } } });
    if (!d) throw notFound('Doubt');
    const question = d.contextType === 'question' && d.contextId ? await this.prisma.question.findUnique({ where: { id: d.contextId }, select: { id: true, code: true, type: true, body: true, answer: true, topicCode: true } }) : null;
    return { ...(await this.thread(d)), student: d.user, abuse: d.abuse, question };
  }

  async adminReply(admin: { id: string; ip?: string }, id: string, b: z.infer<typeof staffReply>) {
    const d = await this.prisma.doubt.findUnique({ where: { id } });
    if (!d) throw notFound('Doubt');
    if (d.status === 'closed') throw conflict('DOUBT_CLOSED', 'This doubt is closed');
    const now = this.clock.now();
    await this.prisma.$transaction([
      this.prisma.doubtMessage.create({ data: { doubtId: id, authorType: 'staff', authorId: admin.id, text: sanitizeRichText(b.text), createdAt: now } }),
      this.prisma.doubt.update({ where: { id }, data: { status: b.close ? 'closed' : 'answered', answeredAt: now, firstResponseAt: d.firstResponseAt ?? now } }),
    ]);
    await this.notifications.notify({ userId: d.userId, kind: 'doubt_answered', dedupeKey: `doubt:${id}:${now.getTime()}`, data: { doubtId: id } });
    await this.audit.log({ actorType: 'admin', actor: admin.id, action: 'doubt.reply', target: id, targetType: 'doubt', ip: admin.ip });
  }

  async adminClose(admin: { id: string; ip?: string }, id: string) {
    const r = await this.prisma.doubt.updateMany({ where: { id, status: { not: 'closed' } }, data: { status: 'closed' } });
    if (r.count === 0 && !(await this.prisma.doubt.findUnique({ where: { id } }))) throw notFound('Doubt');
    await this.audit.log({ actorType: 'admin', actor: admin.id, action: 'doubt.close', target: id, targetType: 'doubt', ip: admin.ip });
  }

  async setAbuse(admin: { id: string; ip?: string }, id: string, abuse: boolean) {
    const r = await this.prisma.doubt.updateMany({ where: { id }, data: { abuse } });
    if (r.count === 0) throw notFound('Doubt');
    await this.audit.log({ actorType: 'admin', actor: admin.id, action: abuse ? 'doubt.flag-abuse' : 'doubt.unflag-abuse', target: id, targetType: 'doubt', ip: admin.ip });
  }

  async stats(days: number) {
    const now = this.clock.now();
    const since = new Date(now.getTime() - days * 24 * HOUR);
    const [byStatus, overdue, dueSoon, abuse, window, ratings] = await Promise.all([
      this.prisma.doubt.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.doubt.count({ where: { status: 'open', slaDueAt: { lt: now } } }),
      this.prisma.doubt.count({ where: { status: 'open', slaDueAt: { gte: now, lt: new Date(now.getTime() + 6 * HOUR) } } }),
      this.prisma.doubt.count({ where: { abuse: true } }),
      this.prisma.doubt.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, firstResponseAt: true, answeredAt: true, slaDueAt: true } }),
      this.prisma.doubt.aggregate({ where: { createdAt: { gte: since }, rating: { not: null } }, _avg: { rating: true }, _count: { rating: true } }),
    ]);
    const first = window.filter((d) => d.firstResponseAt).map((d) => d.firstResponseAt!.getTime() - d.createdAt.getTime());
    const answeredInSla = window.filter((d) => d.firstResponseAt && d.firstResponseAt <= d.slaDueAt).length;
    return {
      rangeDays: days,
      byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      overdue, dueSoon, abuseFlagged: abuse,
      asked: window.length,
      medianFirstResponseHours: median(first),
      medianAnsweredHours: median(window.filter((d) => d.answeredAt).map((d) => d.answeredAt!.getTime() - d.createdAt.getTime())),
      withinSlaPct: first.length ? Math.round((answeredInSla / first.length) * 100) : null,
      avgRating: ratings._avg.rating == null ? null : Math.round(ratings._avg.rating * 10) / 10,
      ratings: ratings._count.rating,
    };
  }
}
