import { Injectable } from '@nestjs/common';
import { AccessLevel, Attempt, AttemptStatus, Prisma, TestKind, TestMode } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { AccessService } from '../access/access.service';
import { ApiError, badRequest, conflict, notFound } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { AnswerDto } from './mocktests.dto';
import { scoreAttempt } from './scoring';

/** Autosave is still accepted this long after the deadline, to absorb clock skew and slow networks. */
const GRACE_MS = 30_000;

type QuestionBody = { en: { q: string; o: string[]; s?: string }; hi: { q: string; o: string[]; s?: string } };

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

@Injectable()
export class MocktestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async list(userId: string, filter: { examId?: string; kind?: TestKind }) {
    const tests = await this.prisma.test.findMany({
      where: { published: true, examId: filter.examId, kind: filter.kind },
      orderBy: [{ examId: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { questions: true } } },
    });
    const paid = await this.access.hasPaidAccess(userId);
    return tests.map((t) => ({
      id: t.id,
      examId: t.examId,
      title: t.title,
      kind: t.kind,
      mode: t.mode,
      access: t.access,
      durationMin: t.durationMin,
      questionCount: t._count.questions,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      locked: t.access === AccessLevel.paid && !paid,
    }));
  }

  async start(userId: string, testId: string) {
    const test = await this.prisma.test.findFirst({
      where: { id: testId, published: true },
      include: { exam: true, questions: { orderBy: { position: 'asc' } } },
    });
    if (!test) throw notFound('Test');
    if (!(await this.access.canAccess(userId, test.access, test.examId))) {
      throw new ApiError(403, 'PAYMENT_REQUIRED', 'A paid plan is required for this test');
    }
    if (test.questions.length === 0) throw conflict('TEST_EMPTY', 'This test has no questions yet');

    const now = new Date();
    if (test.mode === TestMode.live) {
      if (test.startsAt && now < test.startsAt) throw conflict('NOT_OPEN', 'This live test has not started yet');
      if (test.endsAt && now > test.endsAt) throw conflict('ENTRY_CLOSED', 'Entry to this live test is closed');
    }

    // Resume a running attempt instead of creating a second one.
    const running = await this.prisma.attempt.findFirst({
      where: { userId, testId, status: AttemptStatus.in_progress },
      orderBy: { startedAt: 'desc' },
    });
    if (running) {
      if (running.deadlineAt.getTime() + GRACE_MS > now.getTime()) return this.payload(running, test.id);
      await this.finalize(running.id, AttemptStatus.expired);
    }

    if (test.attemptLimit) {
      const used = await this.prisma.attempt.count({ where: { userId, testId } });
      if (used >= test.attemptLimit) throw conflict('ATTEMPT_LIMIT', 'No attempts left for this test');
    }

    const duration = test.durationMin * 60_000;
    const deadline =
      test.mode === TestMode.live && test.startsAt
        ? new Date(test.startsAt.getTime() + duration) // everyone finishes together
        : new Date(now.getTime() + duration);
    const ids = test.questions.map((q) => q.questionId);
    const attempt = await this.prisma.attempt.create({
      data: { userId, testId, deadlineAt: deadline, order: test.shuffle ? shuffle(ids) : ids },
    });
    return this.payload(attempt, test.id);
  }

  private async payload(attempt: Attempt, testId: string) {
    const [rows, saved] = await Promise.all([
      this.prisma.question.findMany({ where: { id: { in: attempt.order } } }),
      this.prisma.attemptAnswer.findMany({ where: { attemptId: attempt.id } }),
    ]);
    const byId = new Map(rows.map((q) => [q.id, q]));
    const questions = attempt.order.map((id, i) => {
      const body = byId.get(id)!.body as unknown as QuestionBody;
      // Answer key and explanations are deliberately NOT sent before submission.
      return { id, position: i + 1, en: { q: body.en.q, o: body.en.o }, hi: { q: body.hi.q, o: body.hi.o } };
    });
    return {
      attemptId: attempt.id,
      testId,
      serverTime: new Date().toISOString(),
      deadlineAt: attempt.deadlineAt,
      questions,
      answers: saved.map((a) => ({
        questionId: a.questionId,
        selected: a.selected,
        flagged: a.flagged,
        timeSpentSec: a.timeSpentSec,
      })),
    };
  }

  private async ownAttempt(userId: string, attemptId: string) {
    const attempt = await this.prisma.attempt.findFirst({ where: { id: attemptId, userId } });
    if (!attempt) throw notFound('Attempt');
    return attempt;
  }

  async saveAnswers(userId: string, attemptId: string, answers: AnswerDto[]) {
    const attempt = await this.ownAttempt(userId, attemptId);
    if (attempt.status !== AttemptStatus.in_progress) throw conflict('ATTEMPT_CLOSED', 'This attempt is already finished');
    if (Date.now() > attempt.deadlineAt.getTime() + GRACE_MS) {
      await this.finalize(attempt.id, AttemptStatus.expired);
      throw conflict('ATTEMPT_EXPIRED', 'Time is over; the attempt was submitted automatically');
    }
    const valid = new Set(attempt.order);
    const unknown = answers.filter((a) => !valid.has(a.questionId)).map((a) => a.questionId);
    if (unknown.length) throw badRequest('UNKNOWN_QUESTION', 'Some questions are not part of this attempt', unknown);

    await this.prisma.$transaction(
      answers.map((a) =>
        this.prisma.attemptAnswer.upsert({
          where: { attemptId_questionId: { attemptId, questionId: a.questionId } },
          create: {
            attemptId,
            questionId: a.questionId,
            selected: a.selected ?? null,
            flagged: a.flagged ?? false,
            timeSpentSec: a.timeSpentSec ?? 0,
          },
          update: {
            selected: a.selected ?? null,
            ...(a.flagged !== undefined ? { flagged: a.flagged } : {}),
            ...(a.timeSpentSec !== undefined ? { timeSpentSec: a.timeSpentSec } : {}),
          },
        }),
      ),
    );
    return { saved: answers.length, serverTime: new Date().toISOString() };
  }

  async submit(userId: string, attemptId: string) {
    const attempt = await this.ownAttempt(userId, attemptId);
    if (attempt.status === AttemptStatus.in_progress) {
      await this.finalize(attempt.id, AttemptStatus.submitted);
    }
    return this.result(userId, attemptId);
  }

  /** Idempotent: only the call that flips in_progress -> finished computes and stores the score. */
  private async finalize(attemptId: string, status: AttemptStatus) {
    const attempt = await this.prisma.attempt.findUnique({
      where: { id: attemptId },
      include: { test: { include: { exam: true } }, answers: true },
    });
    if (!attempt || attempt.status !== AttemptStatus.in_progress) return;

    const questions = await this.prisma.question.findMany({
      where: { id: { in: attempt.order } },
      select: { id: true, answer: true },
    });
    const result = scoreAttempt({
      correctMarks: attempt.test.correctMarks ?? attempt.test.exam.correctMarks,
      negativeFraction: attempt.test.negativeFrac ?? attempt.test.exam.negativeFrac,
      key: new Map(questions.map((q) => [q.id, q.answer])),
      selections: new Map(attempt.answers.map((a) => [a.questionId, a.selected])),
    });
    const now = new Date();
    const spent = attempt.answers.reduce((n, a) => n + a.timeSpentSec, 0);
    await this.prisma.attempt.updateMany({
      where: { id: attemptId, status: AttemptStatus.in_progress },
      data: {
        status,
        submittedAt: now,
        score: result.score,
        maxScore: result.maxScore,
        correct: result.correct,
        wrong: result.wrong,
        unattempted: result.unattempted,
        timeSpentSec: Math.min(spent, Math.round((Math.min(now.getTime(), attempt.deadlineAt.getTime()) - attempt.startedAt.getTime()) / 1000)),
      } satisfies Prisma.AttemptUpdateManyMutationInput,
    });
  }

  async result(userId: string, attemptId: string) {
    let attempt = await this.ownAttempt(userId, attemptId);
    if (attempt.status === AttemptStatus.in_progress) {
      if (Date.now() <= attempt.deadlineAt.getTime()) {
        throw conflict('NOT_SUBMITTED', 'Submit the attempt to see the result');
      }
      await this.finalize(attempt.id, AttemptStatus.expired);
      attempt = await this.ownAttempt(userId, attemptId);
    }
    const [rows, saved] = await Promise.all([
      this.prisma.question.findMany({ where: { id: { in: attempt.order } } }),
      this.prisma.attemptAnswer.findMany({ where: { attemptId } }),
    ]);
    const byId = new Map(rows.map((q) => [q.id, q]));
    const sel = new Map(saved.map((a) => [a.questionId, a]));
    return {
      attemptId: attempt.id,
      testId: attempt.testId,
      status: attempt.status,
      score: attempt.score,
      maxScore: attempt.maxScore,
      correct: attempt.correct,
      wrong: attempt.wrong,
      unattempted: attempt.unattempted,
      timeSpentSec: attempt.timeSpentSec,
      submittedAt: attempt.submittedAt,
      review: attempt.order.map((id, i) => {
        const q = byId.get(id)!;
        const a = sel.get(id);
        return {
          id,
          position: i + 1,
          body: q.body,
          correctOption: q.answer,
          selected: a?.selected ?? null,
          timeSpentSec: a?.timeSpentSec ?? 0,
        };
      }),
    };
  }
}
