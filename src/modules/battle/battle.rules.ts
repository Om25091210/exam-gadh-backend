/** Rules of a 1-v-1 battle. Pure functions so they are easy to test; the server applies them, never the phone. */
export interface BattleConfig {
  questions: number;
  roundMs: number;
  countdownMs: number;
  revealMs: number;
  /** a student who waits this long is paired with a labelled practice partner */
  botAfterMs: number;
  /** free students may play this many battles in total; paid plans are unlimited */
  freeLimit: number;
}

export const BATTLE_DEFAULTS: BattleConfig = { questions: 10, roundMs: 15_000, countdownMs: 3_000, revealMs: 2_500, botAfterMs: 12_000, freeLimit: 5 };

/** Reads optional overrides (used by tests to run a whole battle in a second). */
export function battleConfig(env: NodeJS.ProcessEnv = process.env): BattleConfig {
  const n = (k: string, d: number) => (env[k] && Number.isFinite(Number(env[k])) ? Number(env[k]) : d);
  return {
    questions: n('BATTLE_QUESTIONS', BATTLE_DEFAULTS.questions),
    roundMs: n('BATTLE_ROUND_MS', BATTLE_DEFAULTS.roundMs),
    countdownMs: n('BATTLE_COUNTDOWN_MS', BATTLE_DEFAULTS.countdownMs),
    revealMs: n('BATTLE_REVEAL_MS', BATTLE_DEFAULTS.revealMs),
    botAfterMs: n('BATTLE_BOT_AFTER_MS', BATTLE_DEFAULTS.botAfterMs),
    freeLimit: n('BATTLE_FREE_LIMIT', BATTLE_DEFAULTS.freeLimit),
  };
}

export const BASE_POINTS = 10;
export const MAX_SPEED_BONUS = 5;
/** From this many correct answers in a row the round points are multiplied. */
export const STREAK_FROM = 3;
export const STREAK_MULTIPLIER = 1.5;

/** A correct answer earns 10 plus up to 5 for speed; the third correct answer in a row (and after) earns 1.5x. */
export function roundPoints(a: { correct: boolean; ms: number; roundMs: number; streakBefore: number }): { points: number; streak: number } {
  if (!a.correct) return { points: 0, streak: 0 };
  const speed = Math.round(MAX_SPEED_BONUS * Math.max(0, 1 - a.ms / a.roundMs));
  const streak = a.streakBefore + 1;
  let points = BASE_POINTS + speed;
  if (streak >= STREAK_FROM) points = Math.round(points * STREAK_MULTIPLIER);
  return { points, streak };
}

export interface Tally {
  score: number;
  correct: number;
  totalMs: number;
}
export type Outcome = 'win' | 'loss' | 'draw';

/** Higher score wins; then more correct answers; otherwise it is a draw. */
export function outcomeOf(me: Tally, other: Tally): Outcome {
  if (me.score !== other.score) return me.score > other.score ? 'win' : 'loss';
  if (me.correct !== other.correct) return me.correct > other.correct ? 'win' : 'loss';
  return 'draw';
}

/** Battle points. A practice partner pays less, so bot games cannot be farmed for the leaderboard. */
export function rewardPoints(result: Outcome, vsBot: boolean): number {
  if (result === 'win') return vsBot ? 15 : 25;
  if (result === 'draw') return vsBot ? 5 : 10;
  return 0;
}

/** How far apart two ratings may be to be paired, widening the longer they wait. */
export function matchWindow(waitedMs: number): number {
  return 150 + Math.floor(waitedMs / 1000) * 40;
}
