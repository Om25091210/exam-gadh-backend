import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { istDateString } from '../../common/ist';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const DAY = 86_400_000;
const BATCH = 500;

/**
 * Periodic jobs that create reminders. Every notification carries a dedupe key, so running a job twice
 * (or on two servers) never notifies a student twice.
 */
@Injectable()
export class NotificationJobs implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(NotificationJobs.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly notifications: NotificationsService,
  ) {}

  onApplicationBootstrap() {
    const every = Number(process.env.NOTIFY_JOBS_MS ?? 60_000);
    if (every > 0 && process.env.NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.runOnce().catch((e) => this.log.error(e)), every);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce() {
    const [results, expiring, live] = await Promise.all([this.resultsReleased(), this.plansExpiring(), this.liveSoon()]);
    return { results, expiring, live };
  }

  /** "Your result is ready" for tests whose release time was in the future when the student submitted. */
  async resultsReleased(): Promise<number> {
    const now = this.clock.now();
    const rows = await this.prisma.attemptResult.findMany({
      where: { version: { resultReleaseAt: { lte: now, gte: new Date(now.getTime() - 3 * DAY) } }, attempt: { status: { not: 'in_progress' } } },
      select: { attemptId: true, userId: true, submittedAt: true, version: { select: { resultReleaseAt: true, test: { select: { id: true, titleEn: true, ownerUserId: true } } } } },
      take: BATCH,
    });
    let sent = 0;
    for (const r of rows) {
      if (r.version.test.ownerUserId) continue; // personal practice sets release at once; the student is already looking
      if (r.submittedAt >= r.version.resultReleaseAt!) continue; // submitted after release: they saw the result immediately
      if (await this.notifications.notify({ userId: r.userId, kind: 'result_ready', vars: { title: r.version.test.titleEn }, dedupeKey: `result:${r.attemptId}`, data: { attemptId: r.attemptId, testId: r.version.test.id } })) sent++;
    }
    return sent;
  }

  /** Paid plans ending within 3 days. */
  async plansExpiring(): Promise<number> {
    const now = this.clock.now();
    const rows = await this.prisma.entitlement.findMany({ where: { revokedAt: null, endsAt: { gt: now, lte: new Date(now.getTime() + 3 * DAY) } }, include: { plan: { select: { nameEn: true } } }, take: BATCH });
    let sent = 0;
    for (const e of rows) {
      // a student who already has a later entitlement for the same plan does not need the reminder
      const later = await this.prisma.entitlement.count({ where: { userId: e.userId, planId: e.planId, revokedAt: null, endsAt: { gt: e.endsAt } } });
      if (later) continue;
      if (await this.notifications.notify({ userId: e.userId, kind: 'plan_expiring', vars: { plan: e.plan.nameEn, date: istDateString(e.endsAt) }, dedupeKey: `expiring:${e.id}`, data: { planId: e.planId } })) sent++;
    }
    return sent;
  }

  /** Live tests starting in the next 30 minutes, for students whose target exam matches. */
  async liveSoon(): Promise<number> {
    const now = this.clock.now();
    const versions = await this.prisma.testVersion.findMany({
      where: { status: 'published', test: { mode: 'live', archived: false, ownerUserId: null }, startsAt: { gt: now, lte: new Date(now.getTime() + 30 * 60_000) } },
      include: { test: { select: { id: true, titleEn: true, examId: true } } },
    });
    let sent = 0;
    for (const v of versions) {
      const users = await this.prisma.user.findMany({ where: { status: 'active', deletedAt: null, targetExam: v.test.examId }, select: { id: true }, take: 5000 });
      for (const u of users) {
        if (await this.notifications.notify({ userId: u.id, kind: 'live_test', vars: { title: v.test.titleEn, time: v.startsAt!.toISOString().slice(11, 16) + ' UTC' }, dedupeKey: `live:${v.id}`, data: { testId: v.test.id } })) sent++;
      }
    }
    return sent;
  }
}
