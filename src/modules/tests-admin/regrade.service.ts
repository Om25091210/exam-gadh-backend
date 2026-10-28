import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminPrincipal } from '../admin-auth/admin-auth.types';
import { scoreAttempt } from '../attempts/scoring';
import { snapshotOf, VersionLoader } from '../attempts/version-loader';
import { AuditService } from '../audit/audit.service';

type Actor = { admin: AdminPrincipal; ip?: string };

/**
 * Answer-key correction on a frozen test version (the "official answer key changed" case).
 * It is the only way a published snapshot can change: audited, reasoned, and followed by re-scoring every
 * finished attempt of that version, keeping each student's topic statistics consistent.
 */
@Injectable()
export class RegradeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly versions: VersionLoader,
  ) {}

  async correctKey(a: Actor, testId: string, versionId: string, input: { tvqId: string; newAnswer: number; reason: string; updateQuestionBank: boolean }) {
    const version = await this.prisma.testVersion.findFirst({ where: { id: versionId, testId } });
    if (!version) throw notFound('Test version');
    if (version.status === 'draft') throw badRequest('USE_QUESTION_EDIT', 'A draft version has no snapshot yet; fix the question itself');
    const tvq = await this.prisma.testVersionQuestion.findFirst({ where: { id: input.tvqId, versionId } });
    if (!tvq) throw notFound('Question in this version');
    const oldAnswer = snapshotOf(tvq).answer;
    if (oldAnswer === input.newAnswer) throw conflict('NO_CHANGE', 'The answer key already has this answer');

    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('eg.allow_key_correction', 'on', true)`; // lasts for this transaction only
        const snap = { ...snapshotOf(tvq), answer: input.newAnswer };
        await tx.testVersionQuestion.update({ where: { id: tvq.id }, data: { snapshot: snap as unknown as Prisma.InputJsonValue } });

        const allTvq = await tx.testVersionQuestion.findMany({ where: { versionId }, include: { section: true } });
        const sections = await tx.testSection.findMany({ where: { versionId }, orderBy: { position: 'asc' } });
        const posById = new Map(sections.map((s) => [s.id, s.position]));
        const tvqForScoring = allTvq.map((q) => ({ tvqId: q.id, answer: snapshotOf(q).answer, marks: q.marks ?? version.correctMarks, sectionPos: q.sectionId ? (posById.get(q.sectionId) ?? 0) : 0, topicCode: snapshotOf(q).topicCode }));
        const topic = snapshotOf(tvq).topicCode;

        // Only attempts that answered this question can change.
        const affected = await tx.attempt.findMany({ where: { testVersionId: versionId, status: { not: 'in_progress' }, answers: { some: { tvqId: tvq.id, selected: { not: null } } } }, include: { answers: true, result: true } });
        let changed = 0;
        for (const at of affected) {
          if (!at.result) continue;
          const sel = at.answers.find((x) => x.tvqId === tvq.id)!.selected!;
          const r = scoreAttempt({
            questions: at.questionOrder.map((id) => tvqForScoring.find((q) => q.tvqId === id)!),
            selections: new Map(at.answers.map((x) => [x.tvqId, x.selected])),
            times: new Map(at.answers.map((x) => [x.tvqId, x.timeSpentSec])),
            negativeFraction: version.negativeFraction,
            sections: sections.map((s) => ({ position: s.position, nameEn: s.nameEn, nameHi: s.nameHi })),
            qualifyingPct: version.qualifyingPct,
            qualifyingPctReserved: version.qualifyingPctReserved,
          });
          if (r.score !== at.result.score) changed++;
          await tx.attemptResult.update({
            where: { attemptId: at.id },
            data: { score: r.score, maxScore: r.maxScore, correct: r.correct, wrong: r.wrong, skipped: r.skipped, negativeDeducted: r.negativeDeducted, accuracyPct: r.accuracyPct, sectionScores: r.sectionScores as unknown as Prisma.InputJsonValue, topicScores: r.topicScores as unknown as Prisma.InputJsonValue, qualifiedGeneral: r.qualifiedGeneral, qualifiedReserved: r.qualifiedReserved },
          });
          // Topic statistics: only the "correct" count of this one question's topic can move.
          const wasCorrect = sel === oldAnswer ? 1 : 0;
          const nowCorrect = sel === input.newAnswer ? 1 : 0;
          if (wasCorrect !== nowCorrect) {
            await tx.userTopicStat.updateMany({ where: { userId: at.userId, topicCode: topic }, data: { correct: { increment: nowCorrect - wasCorrect } } });
          }
        }
        if (input.updateQuestionBank) {
          const q = await tx.question.findUnique({ where: { id: tvq.questionId } });
          if (q && q.answer !== input.newAnswer) {
            const upd = await tx.question.update({ where: { id: q.id }, data: { answer: input.newAnswer, version: { increment: 1 } } });
            await tx.questionVersion.create({ data: { questionId: q.id, version: upd.version, body: q.body as Prisma.InputJsonValue, answer: input.newAnswer, changedBy: a.admin.id } });
          }
        }
        await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'test.key_corrected', targetType: 'test', target: testId, before: { answer: oldAnswer }, after: { answer: input.newAnswer }, meta: { versionId, tvqId: tvq.id, reason: input.reason, attempts: affected.length, scoresChanged: changed, updatedQuestionBank: input.updateQuestionBank }, ip: a.ip }, tx);
        return { attemptsRescored: affected.length, scoresChanged: changed };
      },
      { timeout: 60_000 },
    );
    this.versions.invalidate(versionId); // the cached frozen copy still holds the old key
    return { ...result, oldAnswer, newAnswer: input.newAnswer };
  }
}
