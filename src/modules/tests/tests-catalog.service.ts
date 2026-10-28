import { Injectable } from '@nestjs/common';
import { Prisma, TestKind } from '@prisma/client';
import { AccessService } from '../../access/access.service';
import { Clock } from '../../common/clock';
import { notFound } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';

export interface CatalogFilter {
  examId?: string;
  kind?: TestKind;
  subjectCode?: string;
  topicCode?: string;
  access?: 'free' | 'paid';
  seriesId?: string;
  pyqYear?: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class TestsCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly clock: Clock,
  ) {}

  async list(userId: string, f: CatalogFilter) {
    const where: Prisma.TestWhereInput = {
      archived: false,
      publishedVersionId: { not: null },
      examId: f.examId,
      kind: f.kind,
      subjectCode: f.subjectCode,
      topicCode: f.topicCode,
      access: f.access,
      pyqYear: f.pyqYear,
      ...(f.seriesId ? { series: { some: { seriesId: f.seriesId } } } : {}),
    };
    const [total, tests, paid] = await Promise.all([
      this.prisma.test.count({ where }),
      this.prisma.test.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (f.page - 1) * f.pageSize, take: f.pageSize }),
      this.access.hasPaidAccess(userId),
    ]);
    const versionIds = tests.map((t) => t.publishedVersionId!).filter(Boolean);
    // Three batched queries instead of one per test (no N+1).
    const [versions, attempts, bests] = await Promise.all([
      this.prisma.testVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, durationMin: true, questionCount: true, maxScore: true, startsAt: true, endsAt: true, resultReleaseAt: true, sectionalTimers: true, attemptLimit: true } }),
      this.prisma.attempt.findMany({ where: { userId, version: { testId: { in: tests.map((t) => t.id) } } }, select: { id: true, status: true, version: { select: { testId: true } } }, orderBy: { startedAt: 'desc' } }),
      this.prisma.attemptResult.groupBy({ by: ['testVersionId'], where: { userId, testVersionId: { in: versionIds } }, _max: { score: true } }),
    ]);
    const vById = new Map(versions.map((v) => [v.id, v]));
    const best = new Map(bests.map((b) => [b.testVersionId, b._max.score]));
    const mine = new Map<string, { count: number; running?: string }>();
    for (const a of attempts) {
      const m = mine.get(a.version.testId) ?? { count: 0 };
      m.count++;
      if (a.status === 'in_progress') m.running ??= a.id;
      mine.set(a.version.testId, m);
    }
    const now = this.clock.now();
    return {
      page: f.page,
      pageSize: f.pageSize,
      total,
      items: tests.map((t) => {
        const v = vById.get(t.publishedVersionId!)!;
        const m = mine.get(t.id);
        return {
          id: t.id,
          titleEn: t.titleEn,
          titleHi: t.titleHi,
          examId: t.examId,
          kind: t.kind,
          mode: t.mode,
          access: t.access,
          subjectCode: t.subjectCode,
          topicCode: t.topicCode,
          pyqYear: t.pyqYear,
          durationMin: v.durationMin,
          questionCount: v.questionCount,
          maxScore: v.maxScore,
          sectionalTimers: v.sectionalTimers,
          startsAt: v.startsAt,
          endsAt: v.endsAt,
          resultReleaseAt: v.resultReleaseAt,
          live: t.mode === 'live' && (!v.endsAt || now <= v.endsAt),
          locked: t.access === 'paid' && !paid,
          mine: { attempts: m?.count ?? 0, inProgressAttemptId: m?.running ?? null, bestScore: best.get(t.publishedVersionId!) ?? null },
        };
      }),
    };
  }

  /** Everything the instructions screen needs before a student presses Start. */
  async detail(userId: string, testId: string) {
    const test = await this.prisma.test.findFirst({ where: { id: testId, archived: false, publishedVersionId: { not: null } } });
    if (!test) throw notFound('Test');
    const v = await this.prisma.testVersion.findUniqueOrThrow({
      where: { id: test.publishedVersionId! },
      include: { sections: { orderBy: { position: 'asc' }, include: { _count: { select: { questions: true } } } } },
    });
    const [paid, attempts] = await Promise.all([
      this.access.canAccess(userId, test.access, test.examId),
      this.prisma.attempt.findMany({ where: { userId, testVersionId: v.id }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, attemptNo: true, isRanked: true, startedAt: true, submittedAt: true } }),
    ]);
    return {
      id: test.id,
      titleEn: test.titleEn,
      titleHi: test.titleHi,
      examId: test.examId,
      kind: test.kind,
      mode: test.mode,
      access: test.access,
      locked: !paid,
      version: v.version,
      durationMin: v.durationMin,
      questionCount: v.questionCount,
      maxScore: v.maxScore,
      scheme: { correctMarks: v.correctMarks, negativeFraction: v.negativeFraction, qualifyingPct: v.qualifyingPct, qualifyingPctReserved: v.qualifyingPctReserved, countsTowardMerit: v.countsTowardMerit },
      sectionalTimers: v.sectionalTimers,
      sections: v.sections.map((s) => ({ position: s.position, nameEn: s.nameEn, nameHi: s.nameHi, durationMin: s.durationMin, count: s._count.questions })),
      attemptLimit: v.attemptLimit,
      startsAt: v.startsAt,
      endsAt: v.endsAt,
      resultReleaseAt: v.resultReleaseAt,
      instructions: { en: v.instructionsEn, hi: v.instructionsHi },
      myAttempts: attempts,
    };
  }
}
