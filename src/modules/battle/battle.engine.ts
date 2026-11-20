import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Server } from 'socket.io';
import { publicQuestionView } from '../questions/question.schemas';
import { randomBotName } from './battle.names';
import { BattleService, BattleQuestion } from './battle.service';
import { matchWindow, outcomeOf, rewardPoints, roundPoints } from './battle.rules';

interface AnswerRec {
  i: number;
  option: number | null;
  ms: number;
  correct: boolean;
  points: number;
}
interface Pl {
  userId: string | null;
  rowId: string;
  name: string;
  isBot: boolean;
  rating: number;
  socketId: string | null;
  score: number;
  correct: number;
  totalMs: number;
  streak: number;
  bestStreak: number;
  answers: AnswerRec[];
  missedRun: number;
  /** practice partner only: chance of a correct answer, 0.70 to 0.80 */
  accuracy: number;
}
type Phase = 'countdown' | 'question' | 'reveal' | 'done';
interface Room {
  id: string;
  mode: 'human' | 'bot';
  topicCode: string | null;
  roundMs: number;
  questions: BattleQuestion[];
  players: [Pl, Pl];
  index: number;
  phase: Phase;
  roundStart: number;
  cur: [AnswerRec | null, AnswerRec | null];
  timer: NodeJS.Timeout | null;
  botTimer: NodeJS.Timeout | null;
}
interface Waiting {
  userId: string;
  name: string;
  socketId: string;
  rating: number;
  topicCode: string | null;
  since: number;
}

export class BattleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Runs battles in memory (one API process) and saves the result at the end. The server owns the clock, the questions and
 * the scoring: the phone only sends "I picked option X for question N" and shows what the server says.
 */
@Injectable()
export class BattleEngine implements OnModuleDestroy {
  private readonly log = new Logger('Battle');
  private server: Server | null = null;
  private readonly queue = new Map<string, Waiting>();
  private readonly rooms = new Map<string, Room>();
  private readonly roomOf = new Map<string, string>(); // userId -> room id
  private readonly socketUser = new Map<string, string>(); // socket id -> user id
  private ticker: NodeJS.Timeout | null = null;
  private forming = new Set<string>();

  constructor(private readonly svc: BattleService) {}

  attach(server: Server) {
    this.server = server;
    this.ticker ??= setInterval(() => void this.matchmake(), 500);
  }

  onModuleDestroy() {
    if (this.ticker) clearInterval(this.ticker);
    for (const r of this.rooms.values()) {
      if (r.timer) clearTimeout(r.timer);
      if (r.botTimer) clearTimeout(r.botTimer);
    }
  }

  private emit(p: Pl, event: string, payload: unknown) {
    if (p.socketId && this.server) this.server.to(p.socketId).emit(event, payload);
  }
  private emitBoth(r: Room, event: string, payload: unknown) {
    for (const p of r.players) this.emit(p, event, payload);
  }

  // ---------------------------------------------------------------- queue
  /** Puts a student in the queue (after the free-battle check). Resumes the battle they are already in. */
  async find(userId: string, name: string, socketId: string, topicCode: string | null) {
    this.socketUser.set(socketId, userId);
    const roomId = this.roomOf.get(userId);
    if (roomId && this.rooms.has(roomId)) {
      this.resume(userId, socketId);
      return { status: 'resumed' as const };
    }
    const q = await this.svc.quota(userId);
    if (!q.canPlay) throw new BattleError('BATTLE_LIMIT', 'Free battles are over. Get a plan to keep playing.', { used: q.used, limit: q.limit });
    const rating = (await this.svc.rating(userId)).points;
    this.queue.set(userId, { userId, name, socketId, rating, topicCode, since: Date.now() });
    return { status: 'queued' as const, botAfterMs: this.svc.config.botAfterMs };
  }

  cancel(userId: string) {
    return this.queue.delete(userId);
  }

  private async matchmake() {
    if (this.queue.size === 0) return;
    const now = Date.now();
    const waiting = [...this.queue.values()].sort((a, b) => a.since - b.since);
    for (const w of waiting) {
      if (!this.queue.has(w.userId) || this.forming.has(w.userId)) continue;
      const candidate = waiting
        .filter((o) => o.userId !== w.userId && this.queue.has(o.userId) && !this.forming.has(o.userId) && o.topicCode === w.topicCode)
        .filter((o) => Math.abs(o.rating - w.rating) <= matchWindow(Math.max(now - w.since, now - o.since)))
        .sort((a, b) => Math.abs(a.rating - w.rating) - Math.abs(b.rating - w.rating))[0];
      if (candidate) {
        this.forming.add(w.userId).add(candidate.userId);
        this.queue.delete(w.userId);
        this.queue.delete(candidate.userId);
        void this.form('human', [w, candidate]).finally(() => {
          this.forming.delete(w.userId);
          this.forming.delete(candidate.userId);
        });
      } else if (now - w.since >= this.svc.config.botAfterMs) {
        this.forming.add(w.userId);
        this.queue.delete(w.userId);
        void this.form('bot', [w]).finally(() => this.forming.delete(w.userId));
      }
    }
  }

  private async form(mode: 'human' | 'bot', who: Waiting[]) {
    const cfg = this.svc.config;
    const topic = who[0].topicCode;
    try {
      const questions = await this.svc.pickQuestions(topic);
      if (!questions) throw new BattleError('BATTLE_UNAVAILABLE', 'Not enough questions for a battle yet');
      const botName = randomBotName(who[0].name);
      const specs = mode === 'human' ? who.map((w) => ({ userId: w.userId as string | null, isBot: false, displayName: shortName(w.name) })) : [{ userId: who[0].userId as string | null, isBot: false, displayName: shortName(who[0].name) }, { userId: null, isBot: true, displayName: botName }];
      const battle = await this.svc.createBattle({ mode, topicCode: topic, questionIds: questions.map((q) => q.id), roundMs: cfg.roundMs, players: specs });
      // the database does not promise row order: match each row to its student (or to the bot) explicitly
      const mk = (spec: { userId: string | null; isBot: boolean }): Pl => {
        const row = battle.players.find((r) => (spec.isBot ? r.isBot : r.userId === spec.userId))!;
        const w = spec.isBot ? undefined : who.find((x) => x.userId === spec.userId);
        return { userId: row.userId, rowId: row.id, name: row.displayName, isBot: row.isBot, rating: w?.rating ?? who[0].rating, socketId: w?.socketId ?? null, score: 0, correct: 0, totalMs: 0, streak: 0, bestStreak: 0, answers: [], missedRun: 0, accuracy: row.isBot ? 0.7 + Math.random() * 0.1 : 0 };
      };
      const room: Room = { id: battle.id, mode, topicCode: topic, roundMs: cfg.roundMs, questions, players: [mk(specs[0]), mk(specs[1])], index: 0, phase: 'countdown', roundStart: 0, cur: [null, null], timer: null, botTimer: null };
      this.rooms.set(room.id, room);
      for (const p of room.players) if (p.userId) this.roomOf.set(p.userId, room.id);
      for (let i = 0; i < 2; i++) this.emit(room.players[i], 'battle:matched', this.matchedPayload(room, i));
      room.timer = setTimeout(() => this.startRound(room), cfg.countdownMs);
    } catch (e) {
      const err = e instanceof BattleError ? e : new BattleError('BATTLE_FAILED', 'Could not start the battle');
      if (!(e instanceof BattleError)) this.log.error(`could not form battle: ${(e as Error).message}`);
      for (const w of who) if (this.server) this.server.to(w.socketId).emit('battle:error', { code: err.code, message: err.message });
    }
  }

  private matchedPayload(r: Room, me: number) {
    const you = r.players[me];
    const other = r.players[1 - me];
    return {
      battleId: r.id,
      total: r.questions.length,
      roundMs: r.roundMs,
      countdownMs: this.svc.config.countdownMs,
      you: { name: you.name, rating: you.rating },
      // a practice partner is always shown as one
      opponent: { name: other.name, rating: other.rating, isBot: other.isBot },
    };
  }

  // ---------------------------------------------------------------- rounds
  private startRound(r: Room) {
    r.phase = 'question';
    r.roundStart = Date.now();
    r.cur = [null, null];
    const q = r.questions[r.index];
    const payload = { battleId: r.id, index: r.index, total: r.questions.length, roundMs: r.roundMs, endsAt: r.roundStart + r.roundMs, serverNow: r.roundStart, question: publicQuestionView({ type: q.type, body: q.body }) };
    this.emitBoth(r, 'battle:question', payload);
    r.timer = setTimeout(() => this.endRound(r), r.roundMs);
    const botIdx = r.players.findIndex((p) => p.isBot);
    if (botIdx >= 0) {
      // answers like a person: not instantly, not at the last second
      const margin = Math.min(2500, r.roundMs * 0.2);
      const lo = margin;
      const hi = Math.max(lo + 1, r.roundMs - margin);
      r.botTimer = setTimeout(() => this.botAnswer(r, botIdx), lo + Math.random() * (hi - lo));
    }
  }

  private botAnswer(r: Room, idx: number) {
    if (r.phase !== 'question' || r.cur[idx]) return;
    const q = r.questions[r.index];
    const bot = r.players[idx];
    const right = Math.random() < bot.accuracy;
    const wrong = [0, 1, 2, 3].filter((o) => o !== q.answer);
    this.record(r, idx, right ? q.answer : wrong[Math.floor(Math.random() * wrong.length)]);
  }

  /** A student picked an option. Only the first answer per round counts. */
  answer(userId: string, battleId: string, index: number, option: number) {
    const r = this.rooms.get(battleId);
    if (!r) throw new BattleError('BATTLE_NOT_FOUND', 'This battle is over');
    const idx = r.players.findIndex((p) => p.userId === userId);
    if (idx < 0) throw new BattleError('NOT_IN_BATTLE', 'You are not in this battle');
    if (r.phase !== 'question' || index !== r.index) throw new BattleError('ROUND_CLOSED', 'That question is closed');
    if (!Number.isInteger(option) || option < 0 || option > 3) throw new BattleError('INVALID_OPTION', 'Pick one of the four options');
    if (r.cur[idx]) throw new BattleError('ALREADY_ANSWERED', 'You already answered');
    this.record(r, idx, option);
  }

  private record(r: Room, idx: number, option: number) {
    const ms = Math.min(r.roundMs, Date.now() - r.roundStart);
    const q = r.questions[r.index];
    const p = r.players[idx];
    const correct = option === q.answer;
    const { points, streak } = roundPoints({ correct, ms, roundMs: r.roundMs, streakBefore: p.streak });
    p.streak = streak;
    p.bestStreak = Math.max(p.bestStreak, streak);
    r.cur[idx] = { i: r.index, option, ms, correct, points };
    p.missedRun = 0;
    this.emit(p, 'battle:answered', { index: r.index });
    this.emit(r.players[1 - idx], 'battle:opponentAnswered', { index: r.index });
    if (r.cur[0] && r.cur[1]) {
      if (r.timer) clearTimeout(r.timer);
      r.timer = setTimeout(() => this.endRound(r), 350);
    }
  }

  private endRound(r: Room) {
    if (r.phase !== 'question') return;
    r.phase = 'reveal';
    if (r.timer) clearTimeout(r.timer);
    if (r.botTimer) clearTimeout(r.botTimer);
    const q = r.questions[r.index];
    for (let i = 0; i < 2; i++) {
      const p = r.players[i];
      let a = r.cur[i];
      if (!a) {
        a = { i: r.index, option: null, ms: r.roundMs, correct: false, points: 0 };
        p.streak = 0;
        p.missedRun += 1;
      }
      p.answers.push(a);
      p.score += a.points;
      p.totalMs += a.ms;
      if (a.correct) p.correct += 1;
    }
    const view = (i: number) => ({ option: r.cur[i]?.option ?? r.players[i].answers.at(-1)!.option, correct: r.players[i].answers.at(-1)!.correct, points: r.players[i].answers.at(-1)!.points, ms: r.players[i].answers.at(-1)!.ms });
    for (let i = 0; i < 2; i++) {
      this.emit(r.players[i], 'battle:reveal', {
        battleId: r.id,
        index: r.index,
        correctOption: q.answer,
        explanation: { en: q.body.en?.explanation ?? null, hi: q.body.hi?.explanation ?? null },
        you: { ...view(i), score: r.players[i].score, streak: r.players[i].streak },
        opponent: { ...view(1 - i), score: r.players[1 - i].score, streak: r.players[1 - i].streak },
      });
    }
    // a student who has left and missed three rounds forfeits
    const gone = r.players.findIndex((p) => !p.isBot && p.socketId === null && p.missedRun >= 3);
    r.timer = setTimeout(() => (gone >= 0 || r.index + 1 >= r.questions.length ? void this.finish(r, gone >= 0 ? gone : null) : this.next(r)), this.svc.config.revealMs);
  }

  private next(r: Room) {
    r.index += 1;
    this.startRound(r);
  }

  private async finish(r: Room, forfeitIdx: number | null) {
    r.phase = 'done';
    if (r.timer) clearTimeout(r.timer);
    if (r.botTimer) clearTimeout(r.botTimer);
    const vsBot = r.mode === 'bot';
    const t = (p: Pl) => ({ score: p.score, correct: p.correct, totalMs: p.totalMs });
    const results = r.players.map((p, i) => (forfeitIdx === i ? 'loss' : forfeitIdx !== null ? 'win' : outcomeOf(t(p), t(r.players[1 - i])))) as Array<'win' | 'loss' | 'draw'>;
    const done = r.players.map((p, i) => ({ rowId: p.rowId, userId: p.userId, isBot: p.isBot, score: p.score, correct: p.correct, totalMs: p.totalMs, answers: p.answers, result: results[i], pointsDelta: p.isBot ? 0 : rewardPoints(results[i], vsBot), bestStreak: p.bestStreak }));
    try {
      await this.svc.finishBattle(r.id, done);
    } catch (e) {
      this.log.error(`could not save battle ${r.id}: ${(e as Error).message}`);
    }
    for (let i = 0; i < 2; i++) {
      const p = r.players[i];
      const me = done[i];
      const rating = p.userId ? await this.svc.me(p.userId).catch(() => null) : null;
      this.emit(p, 'battle:end', {
        battleId: r.id,
        result: results[i],
        forfeit: forfeitIdx !== null,
        you: { score: me.score, correct: me.correct, pointsDelta: me.pointsDelta, rating: rating ? rating.points : null, freeLeft: rating ? rating.freeLeft : null },
        opponent: { name: r.players[1 - i].name, isBot: r.players[1 - i].isBot, score: done[1 - i].score, correct: done[1 - i].correct },
      });
    }
    this.rooms.delete(r.id);
    for (const p of r.players) if (p.userId && this.roomOf.get(p.userId) === r.id) this.roomOf.delete(p.userId);
  }

  // ---------------------------------------------------------------- connections
  /** A student came back (or opened the app on another screen): send them where the battle is now. */
  resume(userId: string, socketId: string) {
    this.socketUser.set(socketId, userId);
    const r = this.rooms.get(this.roomOf.get(userId) ?? '');
    if (!r) return false;
    const idx = r.players.findIndex((p) => p.userId === userId);
    r.players[idx].socketId = socketId;
    r.players[idx].missedRun = 0;
    const q = r.questions[r.index];
    this.emit(r.players[idx], 'battle:resumed', {
      ...this.matchedPayload(r, idx),
      phase: r.phase,
      index: r.index,
      scores: { you: r.players[idx].score, opponent: r.players[1 - idx].score },
      question: r.phase === 'question' ? { battleId: r.id, index: r.index, total: r.questions.length, roundMs: r.roundMs, endsAt: r.roundStart + r.roundMs, serverNow: Date.now(), question: publicQuestionView({ type: q.type, body: q.body }), answered: !!r.cur[idx] } : null,
    });
    return true;
  }

  isInBattle(userId: string) {
    return this.roomOf.has(userId);
  }

  disconnect(socketId: string) {
    const userId = this.socketUser.get(socketId);
    this.socketUser.delete(socketId);
    if (!userId) return;
    if (this.queue.get(userId)?.socketId === socketId) this.queue.delete(userId);
    const r = this.rooms.get(this.roomOf.get(userId) ?? '');
    const p = r?.players.find((x) => x.userId === userId);
    if (p && p.socketId === socketId) p.socketId = null;
  }
}

/** "Asha Verma" -> "Asha V." (the same style as the leaderboards). */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0] || 'Student';
}
