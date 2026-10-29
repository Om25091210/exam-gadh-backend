import { Injectable } from '@nestjs/common';
import { SessionService } from '../../auth/session.service';
import { notFound } from '../../common/api-error';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /** Everything we hold about the student, as one JSON document (FR-006). Secrets and other people's data are left out. */
  async export(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw notFound('User');
    const [attempts, results, bookmarks, notes, doubts, orders, mentor, notifications, enrollments, entitlements] = await Promise.all([
      this.prisma.attempt.findMany({ where: { userId }, orderBy: { startedAt: 'asc' }, include: { answers: true }, take: 2000 }),
      this.prisma.attemptResult.findMany({ where: { userId }, orderBy: { submittedAt: 'asc' }, take: 2000 }),
      this.prisma.bookmark.findMany({ where: { userId } }),
      this.prisma.userNote.findMany({ where: { userId } }),
      this.prisma.doubt.findMany({ where: { userId }, include: { messages: true }, take: 2000 }),
      this.prisma.order.findMany({ where: { userId }, include: { payments: { select: { razorpayPaymentId: true, amountPaise: true, method: true, status: true, createdAt: true } } } }),
      this.prisma.mentorRequest.findMany({ where: { userId } }),
      this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 1000 }),
      this.prisma.enrollment.findMany({ where: { userId } }),
      this.prisma.entitlement.findMany({ where: { userId } }),
    ]);
    return {
      exportedAt: this.clock.now().toISOString(),
      profile: { id: user.id, name: user.name, email: user.email, language: user.language, district: user.district, targetExam: user.targetExam, showOnLeaderboard: user.showOnLeaderboard, createdAt: user.createdAt },
      attempts: attempts.map((a) => ({ id: a.id, testVersionId: a.testVersionId, status: a.status, isRanked: a.isRanked, isPractice: a.isPractice, startedAt: a.startedAt, submittedAt: a.submittedAt, answers: a.answers.map((x) => ({ question: x.tvqId, selected: x.selected, marked: x.marked, timeSpentSec: x.timeSpentSec })) })),
      results: results.map((r) => ({ attemptId: r.attemptId, score: r.score, maxScore: r.maxScore, correct: r.correct, wrong: r.wrong, skipped: r.skipped, accuracyPct: r.accuracyPct, submittedAt: r.submittedAt })),
      bookmarks, notes, enrollments, entitlements,
      doubts: doubts.map((d) => ({ id: d.id, status: d.status, createdAt: d.createdAt, messages: d.messages.map((m) => ({ from: m.authorType, text: m.text, createdAt: m.createdAt })) })),
      orders, mentorRequests: mentor, notifications,
    };
  }

  /**
   * Deletes the account. Personal details are erased and the sign-in is released; test results stay as anonymous
   * history, and orders and invoices are kept because tax rules require it.
   */
  async delete(userId: string, ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.deletedAt) throw notFound('User');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { deletedAt: this.clock.now(), name: 'Deleted user', email: `deleted-${userId}@deleted.invalid`, googleSub: `deleted:${userId}`, avatarUrl: null, phone: null, district: null, targetExam: null, showOnLeaderboard: false } }),
      this.prisma.bookmark.deleteMany({ where: { userId } }),
      this.prisma.userNote.deleteMany({ where: { userId } }),
      this.prisma.notification.deleteMany({ where: { userId } }),
      this.prisma.doubt.deleteMany({ where: { userId } }),
      this.prisma.mentorRequest.deleteMany({ where: { userId } }),
      this.prisma.enrollment.deleteMany({ where: { userId } }),
      this.prisma.userTopicStat.deleteMany({ where: { userId } }),
    ]);
    await this.sessions.revokeAllForUser(userId, 'LOGOUT');
    await this.audit.log({ actorType: 'user', actor: userId, action: 'account.delete', target: userId, targetType: 'user', ip });
  }
}
