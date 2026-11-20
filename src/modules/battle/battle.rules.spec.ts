import { matchWindow, outcomeOf, rewardPoints, roundPoints } from './battle.rules';

describe('battle rules', () => {
  it('a wrong or missing answer earns nothing and breaks the streak', () => {
    expect(roundPoints({ correct: false, ms: 1000, roundMs: 15000, streakBefore: 4 })).toEqual({ points: 0, streak: 0 });
  });
  it('a correct answer earns 10 plus up to 5 for speed', () => {
    expect(roundPoints({ correct: true, ms: 0, roundMs: 15000, streakBefore: 0 })).toEqual({ points: 15, streak: 1 });
    expect(roundPoints({ correct: true, ms: 15000, roundMs: 15000, streakBefore: 0 })).toEqual({ points: 10, streak: 1 });
    expect(roundPoints({ correct: true, ms: 7500, roundMs: 15000, streakBefore: 0 }).points).toBe(13);
  });
  it('the third correct answer in a row (and after) is multiplied by 1.5', () => {
    expect(roundPoints({ correct: true, ms: 15000, roundMs: 15000, streakBefore: 1 })).toEqual({ points: 10, streak: 2 });
    expect(roundPoints({ correct: true, ms: 15000, roundMs: 15000, streakBefore: 2 })).toEqual({ points: 15, streak: 3 });
    expect(roundPoints({ correct: true, ms: 0, roundMs: 15000, streakBefore: 5 }).points).toBe(23);
  });
  it('higher score wins, then more correct answers, otherwise a draw', () => {
    expect(outcomeOf({ score: 50, correct: 4, totalMs: 9 }, { score: 40, correct: 5, totalMs: 1 })).toBe('win');
    expect(outcomeOf({ score: 40, correct: 4, totalMs: 9 }, { score: 40, correct: 5, totalMs: 1 })).toBe('loss');
    expect(outcomeOf({ score: 40, correct: 4, totalMs: 9 }, { score: 40, correct: 4, totalMs: 1 })).toBe('draw');
  });
  it('wins pay points, losses pay nothing, and a practice partner pays less', () => {
    expect(rewardPoints('win', false)).toBe(25);
    expect(rewardPoints('draw', false)).toBe(10);
    expect(rewardPoints('loss', false)).toBe(0);
    expect(rewardPoints('win', true)).toBe(15);
  });
  it('the matching window widens with waiting time', () => {
    expect(matchWindow(0)).toBe(150);
    expect(matchWindow(10_000)).toBe(550);
  });
});
