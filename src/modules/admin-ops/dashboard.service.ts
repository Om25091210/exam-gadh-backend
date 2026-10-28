import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Clock } from '../../common/clock';
import { badRequest } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';

export const dashboardQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const DAY = 86_400_000;
const n = (v: bigint | number | null | undefined) => Number(v ?? 0);

/** Everything on the dashboard is computed from the database for the chosen date range; nothing is hard-coded. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async get(q: z.infer<typeof dashboardQuery>) {
    const now = this.clock.now();
    const to = q.to ?? now;
    const from = q.from ?? new Date(to.getTime() - 29 * DAY);
    if (from >= to) throw badRequest('INVALID_RANGE', '"from" must be before "to"');
    if (to.getTime() - from.getTime() > 366 * DAY) throw badRequest('RANGE_TOO_LONG', 'Choose a range of at most one year');
    const sinceDay = new Date(now.getTime() - DAY);
    const sinceWeek = new Date(now.getTime() - 7 * DAY);
    const sinceMonth = new Date(now.getTime() - 30 * DAY);
    const activeEnt = { revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } };

    const activeUsers = (since: Date) => this.prisma.session.findMany({ where: { lastSeenAt: { gte: since } }, distinct: ['userId'], select: { userId: true } }).then((r) => r.length);

    const [students, newStudents, suspended, paidStudents, dau, wau, mau, enrollments, grants, attemptsStarted, attemptsDone, scoreAgg, autoSubmitted, revenue] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.user.count({ where: { status: 'suspended' } }),
      this.prisma.user.count({ where: { entitlements: { some: activeEnt } } }),
      activeUsers(sinceDay),
      activeUsers(sinceWeek),
      activeUsers(sinceMonth),
      this.prisma.enrollment.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.entitlement.groupBy({ by: ['source'], where: { createdAt: { gte: from, lte: to } }, _count: { _all: true } }),
      this.prisma.attempt.count({ where: { startedAt: { gte: from, lte: to } } }),
      this.prisma.attemptResult.count({ where: { submittedAt: { gte: from, lte: to } } }),
      this.prisma.attemptResult.aggregate({ where: { submittedAt: { gte: from, lte: to }, maxScore: { gt: 0 } }, _avg: { accuracyPct: true } }),
      this.prisma.attempt.count({ where: { startedAt: { gte: from, lte: to }, finalizedBy: 'auto_timer' } }),
      this.prisma.payment.groupBy({ by: ['status'], where: { createdAt: { gte: from, lte: to } }, _sum: { amountPaise: true }, _count: { _all: true } }),
    ]);
    const rev = (s: string) => n(revenue.find((r) => r.status === s)?._sum.amountPaise);
    const percentRows = await this.prisma.$queryRaw<Array<{ avg: number | null }>>`
      SELECT avg(score / NULLIF("maxScore", 0) * 100) AS avg FROM "AttemptResult" WHERE "submittedAt" >= ${from} AND "submittedAt" <= ${to} AND "maxScore" > 0`;

    const series = await this.prisma.$queryRaw<Array<{ day: Date; signups: bigint; active: bigint; attempts: bigint; revenue: bigint }>>`
      SELECT d.day::date AS day,
        (SELECT count(*) FROM "User" u WHERE u."createdAt" >= d.day AND u."createdAt" < d.day + interval '1 day') AS signups,
        (SELECT count(DISTINCT s."userId") FROM "Session" s WHERE s."lastSeenAt" >= d.day AND s."lastSeenAt" < d.day + interval '1 day') AS active,
        (SELECT count(*) FROM "Attempt" a WHERE a."startedAt" >= d.day AND a."startedAt" < d.day + interval '1 day') AS attempts,
        (SELECT COALESCE(sum(p."amountPaise"), 0) FROM "Payment" p WHERE p.status = 'captured' AND p."createdAt" >= d.day AND p."createdAt" < d.day + interval '1 day') AS revenue
      FROM generate_series(date_trunc('day', ${from}::timestamptz), date_trunc('day', ${to}::timestamptz), interval '1 day') AS d(day)
      ORDER BY d.day`;

    const [failedPayments, openReports, doubtsOverdue, doubtsDueSoon, upcomingLive, failedImports, expiring, pendingReview] = await Promise.all([
      this.prisma.order.count({ where: { status: 'failed', createdAt: { gte: sinceDay } } }),
      this.prisma.questionReport.count({ where: { status: 'open' } }),
      this.prisma.doubt.count({ where: { status: 'open', slaDueAt: { lt: now } } }),
      this.prisma.doubt.count({ where: { status: 'open', slaDueAt: { gte: now, lt: new Date(now.getTime() + 6 * 3_600_000) } } }),
      this.prisma.testVersion.count({ where: { status: 'published', test: { mode: 'live', archived: false }, startsAt: { gte: now, lt: new Date(now.getTime() + 7 * DAY) } } }),
      this.prisma.importJob.count({ where: { status: 'failed', createdAt: { gte: sinceWeek } } }),
      this.prisma.entitlement.count({ where: { ...activeEnt, endsAt: { gt: now, lt: new Date(now.getTime() + 7 * DAY) } } }),
      this.prisma.question.count({ where: { status: 'in_review' } }),
    ]);
    const alerts = [
      { key: 'failed_payments', level: 'warning', count: failedPayments, text: 'failed payments in the last 24 hours' },
      { key: 'doubts_overdue', level: 'critical', count: doubtsOverdue, text: 'doubts are past their answer deadline' },
      { key: 'doubts_due_soon', level: 'warning', count: doubtsDueSoon, text: 'doubts are due within 6 hours' },
      { key: 'open_reports', level: 'warning', count: openReports, text: 'student-reported question issues are waiting' },
      { key: 'questions_in_review', level: 'info', count: pendingReview, text: 'questions are waiting for review' },
      { key: 'failed_imports', level: 'warning', count: failedImports, text: 'imports failed this week' },
      { key: 'plans_expiring', level: 'info', count: expiring, text: 'paid plans expire within 7 days' },
      { key: 'live_tests_soon', level: 'info', count: upcomingLive, text: 'live tests start within 7 days' },
    ].filter((a) => a.count > 0);

    return {
      range: { from, to },
      generatedAt: now,
      students: { total: students, new: newStudents, suspended, paid: paidStudents, dau, wau, mau, stickiness: mau ? Math.round((dau / mau) * 1000) / 10 : null },
      enrollments: { seriesEnrollments: enrollments, accessGrants: grants.map((g) => ({ source: g.source, count: g._count._all })) },
      revenue: { grossPaise: rev('captured'), refundedPaise: rev('refunded'), netPaise: rev('captured') - rev('refunded'), payments: n(revenue.find((r) => r.status === 'captured')?._count._all) },
      attempts: { started: attemptsStarted, submitted: attemptsDone, autoSubmitted, avgScorePct: percentRows[0]?.avg == null ? null : Math.round(percentRows[0].avg * 10) / 10, avgAccuracyPct: scoreAgg._avg.accuracyPct == null ? null : Math.round(scoreAgg._avg.accuracyPct * 10) / 10 },
      series: series.map((s) => ({ day: s.day.toISOString().slice(0, 10), signups: n(s.signups), active: n(s.active), attempts: n(s.attempts), revenuePaise: n(s.revenue) })),
      alerts,
    };
  }
}
