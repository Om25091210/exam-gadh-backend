import { Injectable } from '@nestjs/common';
import { AccessLevel, Attempt, AttemptAnswer, Language, Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { ApiError, badRequest, conflict, notFound } from '../../common/api-error';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../../access/access.service';
import { publicQuestionView } from '../questions/question.schemas';
import { SettingsService } from '../settings/settings.service';
import { AnswerStateDto, SaveStateDto, StartAttemptDto } from './attempts.dto';
import { AttemptFinalizer, GRACE_MS } from './attempt-finalizer';
import { openSection, sectionWindows, totalSectionalMinutes } from './section-windows';
import { LoadedVersion, snapshotOf, VersionLoader } from './version-loader';

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

@Injectable()
export class AttemptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    private readonly versions: VersionLoader,
    private readonly finalizer: AttemptFinalizer,
  ) {}

  // ------------------------------------------------------------------ start / resume
  async startOrResume(userId: string, testId: string, opts: StartAttemptDto, clientId: string) {
    const test = await this.prisma.test.findFirst({ where: { id: testId, archived: false, OR: [{ ownerUserId: null }, { ownerUserId: userId }] } }); // someone else's personal set is simply not found
    if (!test || !test.publishedVersionId) throw notFound('Test');
    if (!(await this.access.canAccess(userId, test.access, test.examId))) {
      throw new ApiError(403, 'PAYMENT_REQUIRED', 'A paid plan is required for this test');
    }
    const now = this.clock.now();

    // A running attempt wins, even if the test was re-published meanwhile (it keeps its own frozen version).
    const running = await this.prisma.attempt.findFirst({
      where: { userId, status: 'in_progress', version: { testId } },
      orderBy: { startedAt: 'desc' },
    });
    if (running) {
      if (running.deadlineAt.getTime() + GRACE_MS > now.getTime()) return this.resume(running, clientId);
      await this.finalizer.finalize(running.id, 'auto_timer');
    }

    const v = await this.versions.load(test.publishedVersionId);
    const live = v.test.mode === 'live';
    const windowOpen = live && (!v.endsAt || now <= v.endsAt);
    if (live && v.startsAt && now < v.startsAt) throw conflict('NOT_OPEN', 'This live test has not started yet');

    const previous = await this.prisma.attempt.findMany({ where: { userId, testVersionId: v.id }, select: { isRanked: true, attemptNo: true } });
    // While a live window is open there is exactly one (ranked) attempt; afterwards extra attempts are practice only.
    const limit = windowOpen ? 1 : v.attemptLimit;
    if (limit && previous.length >= limit) throw conflict('ATTEMPT_LIMIT', 'No attempts left for this test');
    const isPractice = opts.practice === true || !!test.ownerUserId || previous.some((p) => p.isRanked) || (live && !windowOpen);

    const durationMs = (v.sectionalTimers ? totalSectionalMinutes(v.sections) : v.durationMin) * 60_000;
    let deadline = new Date(now.getTime() + durationMs);
    if (live && !isPractice && v.startsAt) deadline = new Date(v.startsAt.getTime() + durationMs); // everyone finishes together
    if (deadline.getTime() <= now.getTime() + 30_000) throw conflict('ENTRY_CLOSED', 'Too little time is left to start this live test');

    const sectionOf = this.versions.sectionPositionById(v);
    const groups = new Map<number, string[]>();
    for (const q of v.questions) {
      const pos = q.sectionId ? (sectionOf.get(q.sectionId) ?? 0) : 0;
      (groups.get(pos) ?? groups.set(pos, []).get(pos)!).push(q.id);
    }
    const order = [...groups.keys()].sort((a, b) => a - b).flatMap((pos) => (v.shuffleQuestions ? shuffled(groups.get(pos)!) : groups.get(pos)!));

    const language: Language = opts.language ?? (await this.prisma.user.findUnique({ where: { id: userId }, select: { language: true } }))?.language ?? 'hi';
    try {
      const attempt = await this.prisma.attempt.create({
        data: {
          userId,
          testVersionId: v.id,
          attemptNo: (previous.reduce((m, p) => Math.max(m, p.attemptNo), 0) || 0) + 1,
          isRanked: !isPractice,
          isPractice,
          startedAt: now,
          deadlineAt: deadline,
          questionOrder: order,
          language,
          sectionStarts: v.sectionalTimers ? { [String(v.sections[0]?.position ?? 0)]: now.toISOString() } : undefined,
          lockClientId: clientId,
          lockHeartbeatAt: now,
        },
      });
      return this.payload(attempt, v, []);
    } catch (e) {
      // Two simultaneous starts: the partial unique index lets one win; the other resumes it.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.attempt.findFirst({ where: { userId, status: 'in_progress', version: { testId } } });
        if (again) return this.resume(again, clientId);
      }
      throw e;
    }
  }

  /**
   * Reopens a running attempt by its id (page refresh, "Resume" link). Opening it makes this tab/device the owner,
   * under the same multi-tab policy as starting. A finished attempt answers 409 ATTEMPT_CLOSED.
   */
  async open(userId: string, attemptId: string, clientId: string) {
    const attempt = await this.owned(userId, attemptId);
    if (attempt.status === 'in_progress' && attempt.deadlineAt.getTime() + GRACE_MS <= this.clock.now().getTime()) {
      await this.finalizer.finalize(attempt.id, 'auto_timer');
      throw new ApiError(409, 'ATTEMPT_CLOSED', 'This attempt is already finished');
    }
    if (attempt.status !== 'in_progress') throw new ApiError(409, 'ATTEMPT_CLOSED', 'This attempt is already finished');
    return this.resume(attempt, clientId);
  }

  private async resume(attempt: Attempt, clientId: string) {
    const now = this.clock.now();
    const policy = await this.settings.get('attempt.multiClientPolicy');
    const stale = await this.settings.get('attempt.lockStaleSec');
    const lockAlive = attempt.lockClientId && attempt.lockClientId !== clientId && attempt.lockHeartbeatAt && now.getTime() - attempt.lockHeartbeatAt.getTime() < stale * 1000;
    if (lockAlive && policy === 'block') throw conflict('ATTEMPT_IN_USE', 'This test is open in another tab or device');
    const updated = await this.prisma.attempt.update({ where: { id: attempt.id }, data: { lockClientId: clientId, lockHeartbeatAt: now } });
    const v = await this.versions.load(updated.testVersionId);
    const answers = await this.prisma.attemptAnswer.findMany({ where: { attemptId: attempt.id } });
    return this.payload(updated, v, answers);
  }

  // ------------------------------------------------------------------ payload (no answers, no explanations)
  private payload(attempt: Attempt, v: LoadedVersion, answers: AttemptAnswer[]) {
    const now = this.clock.now();
    const secPos = this.versions.sectionPositionById(v);
    const byId = new Map(v.questions.map((q) => [q.id, q]));
    const questions = attempt.questionOrder.map((id, i) => {
      const q = byId.get(id)!;
      return {
        qid: id,
        position: i + 1,
        sectionPos: q.sectionId ? (secPos.get(q.sectionId) ?? 0) : 0,
        marks: q.marks ?? v.correctMarks,
        ...publicQuestionView(snapshotOf(q)),
      };
    });
    const windows = v.sectionalTimers ? sectionWindows(attempt.startedAt, v.sections, attempt.sectionStarts as Record<string, string> | null) : null;
    return {
      attemptId: attempt.id,
      testId: v.testId,
      versionId: v.id,
      title: { en: v.test.titleEn, hi: v.test.titleHi },
      status: attempt.status,
      isRanked: attempt.isRanked,
      isPractice: attempt.isPractice,
      serverTime: now.toISOString(),
      startedAt: attempt.startedAt,
      deadlineAt: attempt.deadlineAt,
      remainingSec: Math.max(0, Math.floor((attempt.deadlineAt.getTime() - now.getTime()) / 1000)),
      scheme: { correctMarks: v.correctMarks, negativeFraction: v.negativeFraction, sectionalTimers: v.sectionalTimers },
      instructions: { en: v.instructionsEn, hi: v.instructionsHi },
      sections: v.sections.map((s) => ({ position: s.position, nameEn: s.nameEn, nameHi: s.nameHi, durationMin: s.durationMin, count: questions.filter((q) => q.sectionPos === s.position).length })),
      sectionWindows: windows,
      openSection: windows ? (openSection(windows, now)?.position ?? null) : null,
      state: {
        currentIndex: attempt.currentIndex,
        currentSection: attempt.currentSection,
        language: attempt.language,
        seq: attempt.stateSeq,
        answers: answers.map((a) => ({ qid: a.tvqId, selected: a.selected, visited: a.visited, marked: a.marked, timeSpentSec: a.timeSpentSec, seq: a.seq })),
      },
      questions,
    };
  }

  // ------------------------------------------------------------------ autosave
  async saveState(userId: string, attemptId: string, dto: SaveStateDto, clientId: string) {
    const attempt = await this.owned(userId, attemptId);
    const now = this.clock.now();
    if (attempt.status !== 'in_progress') throw new ApiError(409, 'ATTEMPT_CLOSED', 'This attempt is already finished', { status: attempt.status });
    if (now.getTime() > attempt.deadlineAt.getTime() + GRACE_MS) {
      await this.finalizer.finalize(attempt.id, 'auto_timer');
      throw new ApiError(409, 'ATTEMPT_EXPIRED', 'Time is over; the attempt was submitted automatically');
    }
    this.assertLockOwner(attempt, clientId, await this.settings.get('attempt.multiClientPolicy'));
    const v = await this.versions.load(attempt.testVersionId);
    const { rejected } = await this.applyAnswers(attempt, v, dto.answers, now);

    const stale = dto.seq < attempt.stateSeq;
    const windows = v.sectionalTimers ? sectionWindows(attempt.startedAt, v.sections, attempt.sectionStarts as Record<string, string> | null) : null;
    const open = windows ? openSection(windows, now) : null;
    const data: Prisma.AttemptUpdateInput = { lastSyncAt: now, lockHeartbeatAt: now };
    if (!stale) {
      data.stateSeq = dto.seq;
      if (dto.currentIndex !== undefined) data.currentIndex = Math.min(dto.currentIndex, attempt.questionOrder.length - 1);
      if (dto.language) data.language = dto.language;
      // With sectional timers the server decides which section is open; otherwise the client may switch tabs freely.
      if (dto.currentSection !== undefined && !v.sectionalTimers) data.currentSection = dto.currentSection;
    }
    if (open && open.position !== attempt.currentSection) data.currentSection = open.position;
    await this.prisma.attempt.update({ where: { id: attempt.id }, data });
    return {
      saved: dto.answers.length - rejected.length,
      rejected,
      serverTime: now.toISOString(),
      deadlineAt: attempt.deadlineAt,
      remainingSec: Math.max(0, Math.floor((attempt.deadlineAt.getTime() - now.getTime()) / 1000)),
      openSection: open?.position ?? null,
      sectionWindows: windows,
    };
  }

  /** Writes answers whose sequence is not older than the stored one; sections that are closed refuse writes. */
  async applyAnswers(attempt: Attempt, v: LoadedVersion, answers: AnswerStateDto[], now: Date) {
    const inAttempt = new Set(attempt.questionOrder);
    const unknown = answers.filter((a) => !inAttempt.has(a.qid)).map((a) => a.qid);
    if (unknown.length) throw badRequest('UNKNOWN_QUESTION', 'Some questions are not part of this attempt', unknown);

    const secPos = this.versions.sectionPositionById(v);
    const tvqSection = new Map(v.questions.map((q) => [q.id, q.sectionId ? (secPos.get(q.sectionId) ?? 0) : 0]));
    const windows = v.sectionalTimers ? sectionWindows(attempt.startedAt, v.sections, attempt.sectionStarts as Record<string, string> | null) : null;
    const rejected: Array<{ qid: string; reason: string }> = [];
    const accepted: AnswerStateDto[] = [];
    for (const a of answers) {
      const w = windows?.find((x) => x.position === tvqSection.get(a.qid));
      if (w && now >= w.end) rejected.push({ qid: a.qid, reason: 'SECTION_CLOSED' });
      else if (w && now < w.start) rejected.push({ qid: a.qid, reason: 'SECTION_NOT_STARTED' });
      else accepted.push(a);
    }
    if (accepted.length === 0) return { rejected };

    const existing = new Map(
      (await this.prisma.attemptAnswer.findMany({ where: { attemptId: attempt.id, tvqId: { in: accepted.map((a) => a.qid) } } })).map((r) => [r.tvqId, r]),
    );
    await this.prisma.$transaction(
      accepted.flatMap((a) => {
        const cur = existing.get(a.qid);
        if (cur && a.seq < cur.seq) return []; // stale write from an old offline-queue entry
        return [
          this.prisma.attemptAnswer.upsert({
            where: { attemptId_tvqId: { attemptId: attempt.id, tvqId: a.qid } },
            create: { attemptId: attempt.id, tvqId: a.qid, selected: a.selected ?? null, visited: a.visited ?? true, marked: a.marked ?? false, timeSpentSec: a.timeSpentSec ?? 0, seq: a.seq },
            update: {
              ...(a.selected !== undefined ? { selected: a.selected } : {}),
              ...(a.visited !== undefined ? { visited: a.visited } : {}),
              ...(a.marked !== undefined ? { marked: a.marked } : {}),
              ...(a.timeSpentSec !== undefined ? { timeSpentSec: a.timeSpentSec } : {}),
              seq: a.seq,
            },
          }),
        ];
      }),
    );
    return { rejected };
  }

  // ------------------------------------------------------------------ submit
  /** Idempotent: calling again (same or different key) after the attempt is final just returns the final state. */
  async submit(userId: string, attemptId: string, submitKey: string, finalAnswers: AnswerStateDto[] | undefined) {
    const attempt = await this.owned(userId, attemptId);
    if (attempt.status !== 'in_progress') return attempt.id;
    const now = this.clock.now();
    if (now.getTime() <= attempt.deadlineAt.getTime() + GRACE_MS) {
      if (finalAnswers?.length) await this.applyAnswers(attempt, await this.versions.load(attempt.testVersionId), finalAnswers, now);
      await this.finalizer.finalize(attempt.id, 'client', submitKey);
    } else {
      await this.finalizer.finalize(attempt.id, 'auto_timer', submitKey);
    }
    return attempt.id;
  }

  // ------------------------------------------------------------------ sections
  /** Sectional-timer tests: move on to the next section early. Going back is never allowed. */
  async advanceSection(userId: string, attemptId: string, clientId: string) {
    const attempt = await this.owned(userId, attemptId);
    if (attempt.status !== 'in_progress') throw new ApiError(409, 'ATTEMPT_CLOSED', 'This attempt is already finished');
    this.assertLockOwner(attempt, clientId, await this.settings.get('attempt.multiClientPolicy'));
    const v = await this.versions.load(attempt.testVersionId);
    if (!v.sectionalTimers) throw conflict('NO_SECTIONAL_TIMERS', 'This test has no sectional timers');
    const now = this.clock.now();
    const starts = { ...((attempt.sectionStarts as Record<string, string> | null) ?? {}) };
    const windows = sectionWindows(attempt.startedAt, v.sections, starts);
    const open = openSection(windows, now);
    const idx = open ? v.sections.findIndex((s) => s.position === open.position) : v.sections.length;
    const next = v.sections[idx + 1];
    if (!next) throw conflict('LAST_SECTION', 'This is the last section; submit the test instead');
    starts[String(next.position)] = now.toISOString();
    const updated = await this.prisma.attempt.update({ where: { id: attempt.id }, data: { sectionStarts: starts, currentSection: next.position } });
    const w = sectionWindows(updated.startedAt, v.sections, starts);
    return { openSection: next.position, sectionWindows: w, serverTime: now.toISOString() };
  }

  // ------------------------------------------------------------------ helpers
  async owned(userId: string, attemptId: string) {
    const attempt = await this.prisma.attempt.findFirst({ where: { id: attemptId, userId } });
    if (!attempt) throw notFound('Attempt'); // 404 also hides other students' attempt ids
    return attempt;
  }

  private assertLockOwner(attempt: Attempt, clientId: string, policy: 'takeover' | 'block') {
    if (attempt.lockClientId && attempt.lockClientId !== clientId) {
      throw conflict(policy === 'block' ? 'ATTEMPT_IN_USE' : 'ATTEMPT_TAKEN_OVER', policy === 'block' ? 'This test is open in another tab or device' : 'This test was opened in another tab; continue there');
    }
  }
}

export const accessLevelLocked = (level: AccessLevel, paid: boolean) => level === AccessLevel.paid && !paid;
