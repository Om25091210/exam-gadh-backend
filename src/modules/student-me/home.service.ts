import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { istDateString, istDayStart } from '../../common/ist';
import { PrismaService } from '../../prisma/prisma.service';
import { StudentContentService } from '../student-content/student-content.service';
import { currentStreak } from './streak';

const DAY = 86_400_000;

@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly content: StudentContentService,
  ) {}

  /** Scores are shown only after a test's results are released. */
  private releasedFilter(now: Date) {
    return { OR: [{ resultReleaseAt: null }, { resultReleaseAt: { lte: now } }] };
  }

  async activeDays(userId: string, days = 400): Promise<string[]> {
    const since = new Date(this.clock.now().getTime() - days * 86_400_000);
    const rows = await this.prisma.$queryRaw<Array<{ d: string }>>`
      SELECT DISTINCT to_char(("submittedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS d
      FROM "AttemptResult" WHERE "userId" = ${userId}::uuid AND "submittedAt" >= ${since}`;
    return rows.map((r) => r.d);
  }

  async home(userId: string) {
    const now = this.clock.now();
    const today = istDateString(now);
    const [running, live, enrolled, days, results, weak, dailyQuiz, updates, unread, ents] = await Promise.all([
      this.prisma.attempt.findMany({ where: { userId, status: 'in_progress', deadlineAt: { gt: now } }, orderBy: { startedAt: 'desc' }, take: 5, include: { version: { select: { test: { select: { id: true, titleEn: true, titleHi: true } } } }, _count: { select: { answers: true } } } }),
      this.prisma.testVersion.findMany({ where: { status: 'published', test: { mode: 'live', archived: false, ownerUserId: null }, AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }, { startsAt: { lt: new Date(now.getTime() + 7 * DAY) } }] }, orderBy: { startsAt: 'asc' }, take: 10, include: { test: { select: { id: true, titleEn: true, titleHi: true, examId: true } } } }),
      this.prisma.enrollment.findMany({ where: { userId, series: { status: 'published' } }, include: { series: { include: { items: { include: { test: { select: { id: true } } } } } } } }),
      this.activeDays(userId),
      this.prisma.attemptResult.findMany({ where: { userId, version: this.releasedFilter(now) }, orderBy: { submittedAt: 'desc' }, take: 10, include: { version: { select: { test: { select: { id: true, titleEn: true, titleHi: true } } } } } }),
      this.weakTopics(userId, 5),
      this.content.dailyQuiz(userId),
      this.content.updates(),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
      this.prisma.entitlement.findMany({ where: { userId, revokedAt: null, endsAt: { gt: now } }, orderBy: { endsAt: 'asc' }, include: { plan: { select: { nameEn: true, nameHi: true } } } }),
    ]);

    // series progress: which of its tests the student has finished
    const seriesTestIds = enrolled.flatMap((e) => e.series.items.map((i) => i.testId));
    const done = new Set((await this.prisma.attemptResult.findMany({ where: { userId, version: { testId: { in: seriesTestIds } } }, select: { version: { select: { testId: true } } } })).map((r) => r.version.testId));

    return {
      continue: running.map((a) => ({ attemptId: a.id, testId: a.version.test.id, titleEn: a.version.test.titleEn, titleHi: a.version.test.titleHi, deadlineAt: a.deadlineAt, remainingSec: Math.max(0, Math.floor((a.deadlineAt.getTime() - now.getTime()) / 1000)), answered: a._count.answers, total: a.questionOrder.length })),
      live: live.map((v) => ({ id: v.test.id, titleEn: v.test.titleEn, titleHi: v.test.titleHi, examId: v.test.examId, startsAt: v.startsAt, endsAt: v.endsAt, state: v.startsAt && v.startsAt > now ? 'upcoming' : 'open' })),
      series: enrolled.map((e) => ({ id: e.seriesId, titleEn: e.series.titleEn, titleHi: e.series.titleHi, total: e.series.items.length, attempted: e.series.items.filter((i) => done.has(i.testId)).length })),
      streak: currentStreak(days, today),
      trend: results.reverse().map((r) => ({ attemptId: r.attemptId, testId: r.version.test.id, titleEn: r.version.test.titleEn, titleHi: r.version.test.titleHi, pct: r.maxScore ? Math.round((r.score / r.maxScore) * 1000) / 10 : 0, submittedAt: r.submittedAt })),
      weakTopics: weak,
      dailyQuiz,
      announcements: updates.announcements.slice(0, 3),
      unreadNotifications: unread,
      plan: { active: ents.map((e) => ({ planId: e.planId, nameEn: e.plan.nameEn, nameHi: e.plan.nameHi, endsAt: e.endsAt, daysLeft: Math.max(0, Math.ceil((e.endsAt.getTime() - now.getTime()) / DAY)) })), expiringSoon: ents.some((e) => e.endsAt.getTime() - now.getTime() < 7 * DAY) },
    };
  }

  /** The topics where this student is weakest (needs a few answers before a topic is judged). */
  async weakTopics(userId: string, limit: number) {
    const stats = await this.prisma.userTopicStat.findMany({ where: { userId, attempted: { gte: 5 } } });
    const topics = new Map((await this.prisma.topic.findMany({ where: { code: { in: stats.map((s) => s.topicCode) } } })).map((t) => [t.code, t]));
    return stats
      .map((s) => ({ topicCode: s.topicCode, nameEn: topics.get(s.topicCode)?.nameEn ?? s.topicCode, nameHi: topics.get(s.topicCode)?.nameHi ?? s.topicCode, attempted: s.attempted, accuracyPct: Math.round((s.correct / s.attempted) * 100) }))
      .filter((t) => t.accuracyPct < 60)
      .sort((a, b) => a.accuracyPct - b.accuracyPct)
      .slice(0, limit)
      .map((t) => ({ ...t, practice: { topicCode: t.topicCode } }));
  }

  istDayStart = istDayStart;
}
