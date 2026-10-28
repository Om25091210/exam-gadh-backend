import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { FinalizedBy, Prisma } from '@prisma/client';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../prisma/prisma.service';
import { scoreAttempt } from './scoring';
import { snapshotOf, VersionLoader } from './version-loader';

/** Autosave and submit are accepted this long after the deadline (clock skew, slow networks). */
export const GRACE_MS = 15_000;

@Injectable()
export class AttemptFinalizer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(AttemptFinalizer.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly versions: VersionLoader,
    private readonly clock: Clock,
  ) {}

  /**
   * Scores an attempt exactly once. The row lock + the 1:1 AttemptResult primary key make a double submit,
   * a submit racing the auto-submit job, or a retry harmless: only the first caller does any work.
   */
  async finalize(attemptId: string, by: FinalizedBy, submitKey?: string): Promise<boolean> {
    const head = await this.prisma.attempt.findUnique({ where: { id: attemptId }, select: { testVersionId: true, status: true } });
    if (!head || head.status !== 'in_progress') return false;
    const v = await this.versions.load(head.testVersionId);

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Attempt" WHERE id = ${attemptId}::uuid AND status = 'in_progress' FOR UPDATE`;
      if (locked.length === 0) return false; // somebody else finished it first
      const attempt = await tx.attempt.findUniqueOrThrow({ where: { id: attemptId }, include: { answers: true } });

      const secPos = this.versions.sectionPositionById(v);
      const byId = new Map(v.questions.map((q) => [q.id, q]));
      const questions = attempt.questionOrder.map((id) => {
        const q = byId.get(id)!;
        const snap = snapshotOf(q);
        return { tvqId: id, answer: snap.answer, marks: q.marks ?? v.correctMarks, sectionPos: q.sectionId ? (secPos.get(q.sectionId) ?? 0) : 0, topicCode: snap.topicCode };
      });
      const times = new Map(attempt.answers.map((a) => [a.tvqId, a.timeSpentSec]));
      const result = scoreAttempt({
        questions,
        selections: new Map(attempt.answers.map((a) => [a.tvqId, a.selected])),
        times,
        negativeFraction: v.negativeFraction,
        sections: v.sections.map((s) => ({ position: s.position, nameEn: s.nameEn, nameHi: s.nameHi })),
        qualifyingPct: v.qualifyingPct,
        qualifyingPctReserved: v.qualifyingPctReserved,
      });

      const now = this.clock.now();
      const submittedAt = by === 'auto_timer' && now > attempt.deadlineAt ? attempt.deadlineAt : now;
      const wall = Math.max(0, Math.floor((submittedAt.getTime() - attempt.startedAt.getTime()) / 1000));
      const reported = [...times.values()].reduce((n, t) => n + t, 0);
      const timeSpentSec = Math.min(reported || wall, wall);

      await tx.attemptResult.create({
        data: {
          attemptId,
          userId: attempt.userId,
          testVersionId: attempt.testVersionId,
          isRanked: attempt.isRanked,
          score: result.score,
          maxScore: result.maxScore,
          correct: result.correct,
          wrong: result.wrong,
          skipped: result.skipped,
          negativeDeducted: result.negativeDeducted,
          accuracyPct: result.accuracyPct,
          timeSpentSec,
          sectionScores: result.sectionScores as unknown as Prisma.InputJsonValue,
          topicScores: result.topicScores as unknown as Prisma.InputJsonValue,
          qualifiedGeneral: result.qualifiedGeneral,
          qualifiedReserved: result.qualifiedReserved,
          submittedAt,
        },
      });
      await tx.attempt.update({
        where: { id: attemptId },
        data: { status: by === 'client' ? 'submitted' : 'expired', finalizedBy: by, submittedAt, submitKey: submitKey ?? null },
      });
      for (const [topicCode, t] of Object.entries(result.topicScores)) {
        await tx.userTopicStat.upsert({
          where: { userId_topicCode: { userId: attempt.userId, topicCode } },
          create: { userId: attempt.userId, topicCode, attempted: t.attempted, correct: t.correct, timeSec: t.timeSec },
          update: { attempted: { increment: t.attempted }, correct: { increment: t.correct }, timeSec: { increment: t.timeSec } },
        });
      }
      return true;
    });
  }

  // ------------------------------------------------------------------ auto-submit when the client is gone
  onApplicationBootstrap() {
    const every = Number(process.env.ATTEMPT_SWEEP_MS ?? 15_000);
    if (every > 0 && process.env.NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.sweepOnce().catch((e) => this.log.error(e)), every);
      this.timer.unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass: finalize every running attempt past its deadline + grace. Safe with several instances running
   * it at once, because `finalize` itself is idempotent (row lock + unique result row).
   */
  async sweepOnce(batch = 200): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - GRACE_MS);
    const due = await this.prisma.attempt.findMany({ where: { status: 'in_progress', deadlineAt: { lt: cutoff } }, select: { id: true }, take: batch });
    let done = 0;
    for (const a of due) {
      try {
        if (await this.finalize(a.id, 'auto_timer')) done++;
      } catch (e) {
        this.log.error(`auto-submit failed for ${a.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return done;
  }
}
