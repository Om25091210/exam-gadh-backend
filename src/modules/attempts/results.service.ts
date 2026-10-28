import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { conflict, notFound } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';
import { publicQuestionView } from '../questions/question.schemas';
import { AttemptFinalizer, GRACE_MS } from './attempt-finalizer';
import { snapshotOf, VersionLoader } from './version-loader';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Share of the other ranked attempters this score beat (rank 1 of 100 -> 100, last of 100 -> 0). */
export const percentileOf = (rank: number, total: number) => (total <= 1 ? 100 : round2(((total - rank) / (total - 1)) * 100));

const displayName = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
};

@Injectable()
export class ResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versions: VersionLoader,
    private readonly finalizer: AttemptFinalizer,
    private readonly clock: Clock,
  ) {}

  /** Loads the student's own attempt, finishing it first if time ran out while they were away. */
  private async settled(userId: string, attemptId: string) {
    let attempt = await this.prisma.attempt.findFirst({ where: { id: attemptId, userId } });
    if (!attempt) throw notFound('Attempt');
    if (attempt.status === 'in_progress') {
      if (this.clock.now().getTime() <= attempt.deadlineAt.getTime() + GRACE_MS) throw conflict('NOT_SUBMITTED', 'Submit the attempt to see the result');
      await this.finalizer.finalize(attempt.id, 'auto_timer');
      attempt = await this.prisma.attempt.findFirstOrThrow({ where: { id: attemptId, userId } });
    }
    const v = await this.versions.load(attempt.testVersionId);
    const released = !v.resultReleaseAt || this.clock.now() >= v.resultReleaseAt;
    return { attempt, v, released };
  }

  async result(userId: string, attemptId: string) {
    const { attempt, v, released } = await this.settled(userId, attemptId);
    const base = { attemptId: attempt.id, testId: v.testId, status: attempt.status, finalizedBy: attempt.finalizedBy, submittedAt: attempt.submittedAt, isRanked: attempt.isRanked };
    if (!released) return { ...base, released: false, resultReleaseAt: v.resultReleaseAt };

    const res = await this.prisma.attemptResult.findUniqueOrThrow({ where: { attemptId } });
    const agg = await this.prisma.attemptResult.aggregate({
      where: { testVersionId: v.id, isRanked: true },
      _max: { score: true },
      _avg: { score: true, accuracyPct: true },
      _count: { _all: true },
    });
    let rank: number | null = null;
    let percentile: number | null = null;
    const total = agg._count._all;
    if (res.isRanked) {
      const better = await this.prisma.attemptResult.count({
        where: { testVersionId: v.id, isRanked: true, OR: [{ score: { gt: res.score } }, { score: res.score, timeSpentSec: { lt: res.timeSpentSec } }] },
      });
      rank = better + 1;
      percentile = percentileOf(rank, total);
    }
    const topics = await this.prisma.topic.findMany({ where: { code: { in: Object.keys(res.topicScores as object) } }, select: { code: true, nameEn: true, nameHi: true } });
    const names = new Map(topics.map((t) => [t.code, t]));
    const answers = await this.prisma.attemptAnswer.findMany({ where: { attemptId } });
    const times = new Map(answers.map((a) => [a.tvqId, a.timeSpentSec]));

    return {
      ...base,
      released: true,
      score: res.score,
      maxScore: res.maxScore,
      correct: res.correct,
      wrong: res.wrong,
      skipped: res.skipped,
      attempted: res.correct + res.wrong,
      negativeDeducted: res.negativeDeducted,
      accuracyPct: res.accuracyPct,
      timeSpentSec: res.timeSpentSec,
      qualifying: v.qualifyingPct == null ? null : { requiredPct: v.qualifyingPct, requiredPctReserved: v.qualifyingPctReserved, general: res.qualifiedGeneral, reserved: res.qualifiedReserved, countsTowardMerit: v.countsTowardMerit },
      rank,
      percentile,
      rankedAttempters: total,
      comparison: { topperScore: agg._max.score, averageScore: agg._avg.score == null ? null : round2(agg._avg.score), averageAccuracyPct: agg._avg.accuracyPct == null ? null : round2(agg._avg.accuracyPct) },
      sections: res.sectionScores,
      topics: Object.entries(res.topicScores as Record<string, Record<string, number>>).map(([code, t]) => ({
        code,
        nameEn: names.get(code)?.nameEn ?? code,
        nameHi: names.get(code)?.nameHi ?? code,
        ...t,
        accuracyPct: t.attempted ? round2((t.correct / t.attempted) * 100) : null,
      })),
      questionTimes: attempt.questionOrder.map((id, i) => ({ qid: id, position: i + 1, timeSpentSec: times.get(id) ?? 0 })),
    };
  }

  /** Solutions with explanations in both languages; only after the result is released. */
  async review(userId: string, attemptId: string) {
    const { attempt, v, released } = await this.settled(userId, attemptId);
    if (!released) throw conflict('RESULT_NOT_RELEASED', 'Solutions are available after the result is released', { resultReleaseAt: v.resultReleaseAt });
    const answers = new Map((await this.prisma.attemptAnswer.findMany({ where: { attemptId } })).map((a) => [a.tvqId, a]));
    const secPos = this.versions.sectionPositionById(v);
    const byId = new Map(v.questions.map((q) => [q.id, q]));
    return {
      attemptId,
      questions: attempt.questionOrder.map((id, i) => {
        const q = byId.get(id)!;
        const snap = snapshotOf(q);
        const a = answers.get(id);
        const marks = q.marks ?? v.correctMarks;
        const outcome = a?.selected == null ? 'skipped' : a.selected === snap.answer ? 'correct' : 'wrong';
        return {
          qid: id,
          position: i + 1,
          sectionPos: q.sectionId ? (secPos.get(q.sectionId) ?? 0) : 0,
          ...publicQuestionView(snap),
          // full bodies including explanations (the public view strips them)
          en: snap.body.en,
          hi: snap.body.hi,
          correctOption: snap.answer,
          selected: a?.selected ?? null,
          marked: a?.marked ?? false,
          timeSpentSec: a?.timeSpentSec ?? 0,
          outcome,
          marksAwarded: outcome === 'correct' ? marks : outcome === 'wrong' ? round2(-marks * v.negativeFraction) : 0,
          topicCode: snap.topicCode,
          difficulty: snap.difficulty,
        };
      }),
    };
  }

  async leaderboard(userId: string, testId: string, limit = 50) {
    const test = await this.prisma.test.findFirst({ where: { id: testId, archived: false } });
    if (!test?.publishedVersionId) throw notFound('Test');
    const v = await this.versions.load(test.publishedVersionId);
    if (v.resultReleaseAt && this.clock.now() < v.resultReleaseAt) return { released: false, resultReleaseAt: v.resultReleaseAt, entries: [], me: null, total: 0 };

    const where = { testVersionId: v.id, isRanked: true };
    const order = [{ score: 'desc' as const }, { timeSpentSec: 'asc' as const }, { submittedAt: 'asc' as const }];
    const [rows, total, mine] = await Promise.all([
      this.prisma.attemptResult.findMany({ where, orderBy: order, take: Math.min(limit, 100) * 2, include: { user: { select: { id: true, name: true, avatarUrl: true, showOnLeaderboard: true } } } }),
      this.prisma.attemptResult.count({ where }),
      this.prisma.attemptResult.findFirst({ where: { ...where, userId } }),
    ]);
    // Ranks count everybody; hidden profiles (privacy opt-out) are just not shown.
    const entries = rows
      .map((r, i) => ({ rank: i + 1, r }))
      .filter(({ r }) => r.user.showOnLeaderboard || r.userId === userId)
      .slice(0, Math.min(limit, 100))
      .map(({ rank, r }) => ({ rank, name: displayName(r.user.name), avatarUrl: r.user.avatarUrl, score: r.score, maxScore: r.maxScore, timeSpentSec: r.timeSpentSec, isMe: r.userId === userId }));
    let me: { rank: number; score: number; percentile: number } | null = null;
    if (mine) {
      const better = await this.prisma.attemptResult.count({ where: { ...where, OR: [{ score: { gt: mine.score } }, { score: mine.score, timeSpentSec: { lt: mine.timeSpentSec } }] } });
      me = { rank: better + 1, score: mine.score, percentile: percentileOf(better + 1, total) };
    }
    return { released: true, entries, me, total };
  }
}
