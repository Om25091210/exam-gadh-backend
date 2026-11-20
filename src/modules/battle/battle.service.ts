import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessService } from '../../access/access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { displayName } from '../attempts/results.service';
import { QuestionBody } from '../questions/question.schemas';
import { battleConfig, BattleConfig, Outcome } from './battle.rules';

export interface BattleQuestion {
  id: string;
  type: string;
  body: QuestionBody;
  answer: number;
}

export interface FinishedPlayer {
  userId: string | null;
  isBot: boolean;
  score: number;
  correct: number;
  totalMs: number;
  answers: unknown[];
  result: Outcome;
  pointsDelta: number;
  bestStreak: number;
}

@Injectable()
export class BattleService {
  readonly config: BattleConfig = battleConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  /** Free students get a few battles in total; a paid plan lifts the limit. */
  async quota(userId: string) {
    const [paid, used] = await Promise.all([
      this.access.hasPaidAccess(userId),
      this.prisma.battlePlayer.count({ where: { userId, battle: { status: { not: 'cancelled' } } } }),
    ]);
    const limit = this.config.freeLimit;
    return { paid, used, limit, freeLeft: paid ? null : Math.max(0, limit - used), canPlay: paid || used < limit };
  }

  async rating(userId: string) {
    return (await this.prisma.battleRating.findUnique({ where: { userId } })) ?? { userId, points: 0, played: 0, wins: 0, losses: 0, draws: 0, bestStreak: 0, updatedAt: new Date() };
  }

  async me(userId: string) {
    const [q, r] = await Promise.all([this.quota(userId), this.rating(userId)]);
    return { points: r.points, played: r.played, wins: r.wins, losses: r.losses, draws: r.draws, bestStreak: r.bestStreak, ...q };
  }

  /** Random published single-answer questions (optionally from one topic). Null when the bank is too small. */
  async pickQuestions(topicCode?: string | null): Promise<BattleQuestion[] | null> {
    const n = this.config.questions;
    const where: Prisma.QuestionWhereInput = { status: 'published', type: 'single', ...(topicCode ? { topicCode } : {}) };
    const ids = (await this.prisma.question.findMany({ where, select: { id: true }, take: 2000 })).map((q) => q.id);
    if (ids.length < n) return null;
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const chosen = ids.slice(0, n);
    const rows = await this.prisma.question.findMany({ where: { id: { in: chosen } }, select: { id: true, type: true, body: true, answer: true } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return chosen.map((id) => {
      const r = byId.get(id)!;
      return { id: r.id, type: r.type, body: r.body as unknown as QuestionBody, answer: r.answer };
    });
  }

  async createBattle(input: { mode: 'human' | 'bot'; topicCode: string | null; questionIds: string[]; roundMs: number; players: Array<{ userId: string | null; isBot: boolean; displayName: string }> }) {
    return this.prisma.battle.create({
      data: { mode: input.mode, topicCode: input.topicCode, questionIds: input.questionIds, roundMs: input.roundMs, players: { create: input.players.map((p) => ({ userId: p.userId, isBot: p.isBot, displayName: p.displayName })) } },
      include: { players: true },
    });
  }

  /** One transaction: the battle row, both player rows and the students' ratings move together. */
  async finishBattle(battleId: string, players: Array<FinishedPlayer & { rowId: string }>) {
    await this.prisma.$transaction(async (tx) => {
      await tx.battle.update({ where: { id: battleId }, data: { status: 'finished', finishedAt: new Date() } });
      for (const p of players) {
        await tx.battlePlayer.update({ where: { id: p.rowId }, data: { score: p.score, correct: p.correct, totalTimeMs: p.totalMs, answers: p.answers as Prisma.InputJsonValue, result: p.result, pointsDelta: p.pointsDelta } });
        if (!p.userId) continue;
        await tx.battleRating.upsert({
          where: { userId: p.userId },
          create: { userId: p.userId, points: p.pointsDelta, played: 1, wins: p.result === 'win' ? 1 : 0, losses: p.result === 'loss' ? 1 : 0, draws: p.result === 'draw' ? 1 : 0, bestStreak: p.bestStreak },
          update: { points: { increment: p.pointsDelta }, played: { increment: 1 }, wins: { increment: p.result === 'win' ? 1 : 0 }, losses: { increment: p.result === 'loss' ? 1 : 0 }, draws: { increment: p.result === 'draw' ? 1 : 0 } },
        });
        await tx.$executeRaw`UPDATE "BattleRating" SET "bestStreak" = GREATEST("bestStreak", ${p.bestStreak}) WHERE "userId" = ${p.userId}::uuid`;
      }
    });
  }

  async cancelBattle(battleId: string) {
    await this.prisma.battle.update({ where: { id: battleId }, data: { status: 'cancelled', finishedAt: new Date() } }).catch(() => undefined);
  }

  async history(userId: string) {
    const rows = await this.prisma.battlePlayer.findMany({
      where: { userId, battle: { status: 'finished' } },
      orderBy: { battle: { finishedAt: 'desc' } },
      take: 20,
      include: { battle: { include: { players: true } } },
    });
    return rows.map((r) => {
      const other = r.battle.players.find((p) => p.id !== r.id);
      return { battleId: r.battleId, finishedAt: r.battle.finishedAt, result: r.result, score: r.score, correct: r.correct, pointsDelta: r.pointsDelta, opponent: other ? { name: other.displayName, isBot: other.isBot, score: other.score } : null };
    });
  }

  async leaderboard(userId: string, limit = 50) {
    const rows = await this.prisma.battleRating.findMany({ where: { played: { gt: 0 }, user: { showOnLeaderboard: true } }, orderBy: [{ points: 'desc' }, { wins: 'desc' }], take: limit, include: { user: { select: { name: true, avatarUrl: true } } } });
    const mine = await this.prisma.battleRating.findUnique({ where: { userId } });
    const myRank = mine ? (await this.prisma.battleRating.count({ where: { points: { gt: mine.points } } })) + 1 : null;
    return {
      entries: rows.map((r, i) => ({ rank: i + 1, name: displayName(r.user.name), avatarUrl: r.user.avatarUrl, points: r.points, played: r.played, wins: r.wins, isMe: r.userId === userId })),
      me: mine ? { rank: myRank, points: mine.points, played: mine.played, wins: mine.wins } : null,
    };
  }
}
