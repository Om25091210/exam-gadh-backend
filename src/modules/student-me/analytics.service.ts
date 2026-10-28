import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../prisma/prisma.service';
import { buildInsights, MIN_QUESTIONS_FOR_TOPIC } from './recommendations';

const round1 = (n: number) => Math.round(n * 10) / 10;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async analytics(userId: string, days: number) {
    const now = this.clock.now();
    const since = new Date(now.getTime() - days * 86_400_000);
    const [stats, topics, subjects] = await Promise.all([
      this.prisma.userTopicStat.findMany({ where: { userId } }),
      this.prisma.topic.findMany(),
      this.prisma.subject.findMany(),
    ]);
    const tMap = new Map(topics.map((t) => [t.code, t]));
    const sMap = new Map(subjects.map((s) => [s.code, s]));
    const topicRows = stats.map((s) => {
      const t = tMap.get(s.topicCode);
      const acc = s.attempted ? Math.round((s.correct / s.attempted) * 100) : null;
      return {
        topicCode: s.topicCode,
        nameEn: t?.nameEn ?? s.topicCode,
        nameHi: t?.nameHi ?? s.topicCode,
        subjectCode: t?.subjectCode ?? null,
        attempted: s.attempted,
        correct: s.correct,
        accuracyPct: acc,
        avgTimeSec: s.attempted ? Math.round(s.timeSec / s.attempted) : null,
        // heat-map bucket: needs a few answers before it is judged
        strength: s.attempted < MIN_QUESTIONS_FOR_TOPIC ? 'new' : acc! >= 75 ? 'strong' : acc! >= 50 ? 'ok' : 'weak',
      };
    });
    const bySubject = new Map<string, { attempted: number; correct: number }>();
    for (const r of topicRows) {
      const k = r.subjectCode ?? 'other';
      const cur = bySubject.get(k) ?? { attempted: 0, correct: 0 };
      bySubject.set(k, { attempted: cur.attempted + r.attempted, correct: cur.correct + r.correct });
    }

    const weekly = await this.prisma.$queryRaw<Array<{ week: string; avg: number; tests: bigint }>>`
      SELECT to_char(date_trunc('week', (r."submittedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')), 'YYYY-MM-DD') AS week,
             avg(r.score / NULLIF(r."maxScore", 0) * 100) AS avg, count(*) AS tests
      FROM "AttemptResult" r JOIN "TestVersion" v ON v.id = r."testVersionId"
      WHERE r."userId" = ${userId}::uuid AND r."submittedAt" >= ${since} AND (v."resultReleaseAt" IS NULL OR v."resultReleaseAt" <= ${now})
      GROUP BY 1 ORDER BY 1`;

    // Answer-level facts for time-management advice (only finished attempts of released results)
    const [facts] = await this.prisma.$queryRaw<Array<{ answered: bigint; wrong: bigint; rushed_wrong: bigint; slow_correct: bigint; avg_time: number | null }>>`
      SELECT count(*) FILTER (WHERE a.selected IS NOT NULL) AS answered,
             count(*) FILTER (WHERE a.selected IS NOT NULL AND a.selected <> (t.snapshot->>'answer')::int) AS wrong,
             count(*) FILTER (WHERE a.selected IS NOT NULL AND a.selected <> (t.snapshot->>'answer')::int AND a."timeSpentSec" BETWEEN 1 AND 10) AS rushed_wrong,
             count(*) FILTER (WHERE a.selected = (t.snapshot->>'answer')::int AND a."timeSpentSec" > 120) AS slow_correct,
             avg(a."timeSpentSec") FILTER (WHERE a.selected IS NOT NULL AND a."timeSpentSec" > 0) AS avg_time
      FROM "AttemptAnswer" a
      JOIN "Attempt" at ON at.id = a."attemptId" AND at."userId" = ${userId}::uuid AND at.status <> 'in_progress' AND at."submittedAt" >= ${since}
      JOIN "TestVersion" v ON v.id = at."testVersionId" AND (v."resultReleaseAt" IS NULL OR v."resultReleaseAt" <= ${now})
      JOIN "TestVersionQuestion" t ON t.id = a."tvqId"`;
    const marks = await this.prisma.attemptResult.aggregate({ where: { userId, submittedAt: { gte: since } }, _sum: { negativeDeducted: true, score: true }, _count: { _all: true } });
    const gross = (marks._sum.score ?? 0) + (marks._sum.negativeDeducted ?? 0);

    const insights = buildInsights({
      topics: topicRows.map((t) => ({ code: t.topicCode, nameEn: t.nameEn, nameHi: t.nameHi, attempted: t.attempted, correct: t.correct })),
      totalAttempted: topicRows.reduce((n, t) => n + t.attempted, 0),
      wrongAnswers: Number(facts?.wrong ?? 0),
      rushedWrong: Number(facts?.rushed_wrong ?? 0),
      grossMarks: gross,
      negativeDeducted: marks._sum.negativeDeducted ?? 0,
    });

    return {
      rangeDays: days,
      topics: topicRows.sort((a, b) => (a.accuracyPct ?? 101) - (b.accuracyPct ?? 101)),
      subjects: [...bySubject.entries()].map(([code, v]) => ({ subjectCode: code, nameEn: sMap.get(code)?.nameEn ?? code, nameHi: sMap.get(code)?.nameHi ?? code, attempted: v.attempted, accuracyPct: v.attempted ? Math.round((v.correct / v.attempted) * 100) : null })),
      progress: weekly.map((w) => ({ weekStarting: w.week, avgPct: round1(Number(w.avg)), tests: Number(w.tests) })),
      time: { avgSecPerAnswered: facts?.avg_time == null ? null : Math.round(facts.avg_time), rushedWrongAnswers: Number(facts?.rushed_wrong ?? 0), slowCorrectAnswers: Number(facts?.slow_correct ?? 0) },
      marks: { testsTaken: marks._count._all, negativeDeducted: Math.round((marks._sum.negativeDeducted ?? 0) * 100) / 100 },
      insights,
    };
  }
}
