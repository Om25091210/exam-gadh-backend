import { Injectable } from '@nestjs/common';
import { notFound } from '../../common/api-error';
import { csvSafe } from '../../common/rich-text';
import { PrismaService } from '../../prisma/prisma.service';
import { stringify } from 'csv-stringify/sync';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class TestsAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveVersion(testId: string, versionId?: string) {
    const test = await this.prisma.test.findUnique({ where: { id: testId } });
    if (!test) throw notFound('Test');
    const v = versionId
      ? await this.prisma.testVersion.findFirst({ where: { id: versionId, testId } })
      : await this.prisma.testVersion.findFirst({ where: { testId, status: { not: 'draft' } }, orderBy: { version: 'desc' } });
    if (!v) throw notFound('Published version');
    return { test, v };
  }

  async analytics(testId: string, versionId?: string) {
    const { test, v } = await this.resolveVersion(testId, versionId);
    const [ranked, attemptsByStatus, practice] = await Promise.all([
      this.prisma.attemptResult.findMany({ where: { testVersionId: v.id, isRanked: true }, select: { score: true, maxScore: true, timeSpentSec: true, accuracyPct: true } }),
      this.prisma.attempt.groupBy({ by: ['status', 'finalizedBy'], where: { testVersionId: v.id }, _count: { _all: true } }),
      this.prisma.attemptResult.count({ where: { testVersionId: v.id, isRanked: false } }),
    ]);
    const scores = ranked.map((r) => r.score).sort((a, b) => a - b);
    const n = scores.length;
    const mean = n ? scores.reduce((s, x) => s + x, 0) / n : 0;
    const median = n ? (n % 2 ? scores[(n - 1) / 2] : (scores[n / 2 - 1] + scores[n / 2]) / 2) : 0;
    const sd = n ? Math.sqrt(scores.reduce((s, x) => s + (x - mean) ** 2, 0) / n) : 0;
    const max = v.maxScore ?? 0;
    const buckets = [{ label: '<0', count: 0 }, ...Array.from({ length: 10 }, (_, i) => ({ label: `${i * 10}-${i * 10 + 10}%`, count: 0 }))];
    for (const r of ranked) {
      if (r.score < 0) buckets[0].count++;
      else buckets[1 + Math.min(9, Math.floor(max ? (r.score / max) * 10 : 0))].count++;
    }
    const rows = await this.prisma.$queryRaw<Array<{ tvqId: string; position: number; attempted: bigint; correct: bigint; wrong: bigint; marked: bigint; avgTime: number | null; stem: string | null; code: string | null; topic: string }>>`
      SELECT t.id AS "tvqId", t.position,
             count(a."tvqId") FILTER (WHERE a.selected IS NOT NULL) AS attempted,
             count(a."tvqId") FILTER (WHERE a.selected = (t.snapshot->>'answer')::int) AS correct,
             count(a."tvqId") FILTER (WHERE a.selected IS NOT NULL AND a.selected <> (t.snapshot->>'answer')::int) AS wrong,
             count(a."tvqId") FILTER (WHERE a.marked) AS marked,
             avg(a."timeSpentSec") FILTER (WHERE a."timeSpentSec" > 0) AS "avgTime",
             COALESCE(t.snapshot->'body'->'en'->>'stem', t.snapshot->'body'->'hi'->>'stem', t.snapshot->'body'->'en'->>'assertion') AS stem,
             q.code, t.snapshot->>'topicCode' AS topic
      FROM "TestVersionQuestion" t
      JOIN "Question" q ON q.id = t."questionId"
      LEFT JOIN (SELECT ans.* FROM "AttemptAnswer" ans JOIN "Attempt" at ON at.id = ans."attemptId"
                 WHERE at."testVersionId" = ${v.id}::uuid AND at.status <> 'in_progress' AND at."isRanked") a ON a."tvqId" = t.id
      WHERE t."versionId" = ${v.id}::uuid
      GROUP BY t.id, t.position, q.code
      ORDER BY t.position`;
    const questions = rows.map((r) => {
      const attempted = Number(r.attempted);
      const correct = Number(r.correct);
      return {
        tvqId: r.tvqId,
        position: r.position + 1,
        code: r.code,
        topic: r.topic,
        preview: (r.stem ?? '').slice(0, 100),
        attempted,
        correct,
        wrong: Number(r.wrong),
        skipped: n - attempted,
        // difficulty index: share of ALL ranked examinees who got it right (lower = harder)
        difficultyIndex: n ? round2(correct / n) : null,
        // share of those who tried it who got it right
        pCorrectOfAttempted: attempted ? round2(correct / attempted) : null,
        markedForReview: Number(r.marked),
        avgTimeSec: r.avgTime == null ? null : Math.round(Number(r.avgTime)),
      };
    });
    return {
      test: { id: test.id, titleEn: test.titleEn, versionId: v.id, version: v.version, maxScore: v.maxScore },
      attempts: { rankedResults: n, practiceResults: practice, byStatus: attemptsByStatus.map((g) => ({ status: g.status, finalizedBy: g.finalizedBy, count: g._count._all })) },
      scores: { mean: round2(mean), median: round2(median), min: n ? scores[0] : null, max: n ? scores[n - 1] : null, stdDev: round2(sd), avgAccuracyPct: n ? round2(ranked.reduce((s, r) => s + r.accuracyPct, 0) / n) : null, avgTimeSec: n ? Math.round(ranked.reduce((s, r) => s + r.timeSpentSec, 0) / n) : null },
      distribution: buckets,
      questions,
      // hardest first, ignoring questions almost nobody tried
      mostWrong: [...questions].filter((q) => q.attempted >= Math.max(3, Math.ceil(n * 0.2))).sort((a, b) => (a.pCorrectOfAttempted ?? 1) - (b.pCorrectOfAttempted ?? 1)).slice(0, 10),
    };
  }

  /** Ranked results with their rank; names are neutralised against spreadsheet formulas, no e-mail addresses are exported. */
  async resultsCsv(testId: string, versionId?: string) {
    const { v } = await this.resolveVersion(testId, versionId);
    const rows = await this.prisma.attemptResult.findMany({ where: { testVersionId: v.id }, orderBy: [{ isRanked: 'desc' }, { score: 'desc' }, { timeSpentSec: 'asc' }], include: { user: { select: { id: true, name: true, district: true } } } });
    let rank = 0;
    const out = rows.map((r) => [r.isRanked ? ++rank : '', csvSafe(r.user.name), r.user.id, csvSafe(r.user.district ?? ''), r.score, r.maxScore, r.correct, r.wrong, r.skipped, r.accuracyPct, r.timeSpentSec, r.isRanked ? 'ranked' : 'practice', r.submittedAt.toISOString()]);
    const csv = stringify([['rank', 'name', 'student_id', 'district', 'score', 'max_score', 'correct', 'wrong', 'skipped', 'accuracy_pct', 'time_sec', 'type', 'submitted_at'], ...out]);
    return Buffer.from('﻿' + csv, 'utf8');
  }
}
