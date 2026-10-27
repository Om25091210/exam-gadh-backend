import { scoreAttempt } from './scoring';

const key = new Map([['a', 0], ['b', 1], ['c', 2], ['d', 3]]);

describe('scoreAttempt', () => {
  it('gives full marks for all correct', () => {
    const r = scoreAttempt({
      correctMarks: 2,
      negativeFraction: 1 / 3,
      key,
      selections: new Map([['a', 0], ['b', 1], ['c', 2], ['d', 3]]),
    });
    expect(r).toEqual({ score: 8, maxScore: 8, correct: 4, wrong: 0, unattempted: 0 });
  });

  it('applies one-third negative marking and ignores skipped questions', () => {
    const r = scoreAttempt({
      correctMarks: 2,
      negativeFraction: 1 / 3,
      key,
      selections: new Map<string, number | null>([['a', 0], ['b', 0], ['c', null]]),
    });
    // 1 correct (+2), 1 wrong (-0.67), 2 skipped
    expect(r.score).toBe(1.33);
    expect(r).toMatchObject({ correct: 1, wrong: 1, unattempted: 2, maxScore: 8 });
  });

  it('can go negative and never counts unknown question ids', () => {
    const r = scoreAttempt({
      correctMarks: 1,
      negativeFraction: 0.25,
      key,
      selections: new Map([['a', 3], ['b', 3], ['zzz', 0]]),
    });
    expect(r.score).toBe(-0.5);
    expect(r.wrong).toBe(2);
  });
});
