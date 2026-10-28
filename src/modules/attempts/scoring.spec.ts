import { scoreAttempt } from './scoring';
import { percentileOf } from './results.service';

const q = (id: string, answer: number, o: Partial<{ marks: number; sectionPos: number; topicCode: string }> = {}) => ({ tvqId: id, answer, marks: o.marks ?? 2, sectionPos: o.sectionPos ?? 0, topicCode: o.topicCode ?? 'T1' });
const base = { times: new Map<string, number>(), negativeFraction: 1 / 3, sections: [{ position: 0, nameEn: 'A', nameHi: 'क' }] };

describe('scoreAttempt', () => {
  it('full marks, no negatives', () => {
    const r = scoreAttempt({ ...base, questions: [q('a', 0), q('b', 1)], selections: new Map([['a', 0], ['b', 1]]) });
    expect(r).toMatchObject({ score: 4, maxScore: 4, correct: 2, wrong: 0, skipped: 0, negativeDeducted: 0, accuracyPct: 100 });
  });

  it('wrong answers cost marks * negative fraction; skipped cost nothing', () => {
    const r = scoreAttempt({ ...base, questions: [q('a', 0), q('b', 1), q('c', 2), q('d', 3)], selections: new Map<string, number | null>([['a', 0], ['b', 0], ['c', null]]) });
    expect(r).toMatchObject({ score: 1.33, correct: 1, wrong: 1, skipped: 2, negativeDeducted: 0.67, accuracyPct: 50 });
  });

  it('can be negative overall', () => {
    const r = scoreAttempt({ ...base, negativeFraction: 0.5, questions: [q('a', 0, { marks: 4 }), q('b', 0, { marks: 4 })], selections: new Map([['a', 1], ['b', 2]]) });
    expect(r.score).toBe(-4);
    expect(r.accuracyPct).toBe(0);
  });

  it('honours per-question marks and ignores selections for unknown questions', () => {
    const r = scoreAttempt({ ...base, questions: [q('a', 0, { marks: 4 }), q('b', 1, { marks: 1 })], selections: new Map([['a', 0], ['b', 1], ['ghost', 0]]) });
    expect(r).toMatchObject({ score: 5, maxScore: 5, correct: 2 });
  });

  it('breaks down by section and topic', () => {
    const r = scoreAttempt({
      ...base,
      sections: [{ position: 0, nameEn: 'A', nameHi: 'क' }, { position: 1, nameEn: 'B', nameHi: 'ख' }],
      questions: [q('a', 0, { sectionPos: 0, topicCode: 'X' }), q('b', 1, { sectionPos: 1, topicCode: 'Y' }), q('c', 2, { sectionPos: 1, topicCode: 'Y' })],
      selections: new Map([['a', 0], ['b', 1], ['c', 0]]),
      times: new Map([['a', 10], ['b', 20], ['c', 30]]),
    });
    expect(r.sectionScores.map((s) => [s.position, s.score, s.maxScore, s.correct, s.wrong])).toEqual([[0, 2, 2, 1, 0], [1, 1.33, 4, 1, 1]]);
    expect(r.topicScores.Y).toEqual({ attempted: 2, correct: 1, wrong: 1, marks: 1.33, timeSec: 50 });
    expect(r.topicScores.X.timeSec).toBe(10);
  });

  it('qualifying papers: general and reserved cut-offs are checked separately', () => {
    const questions = Array.from({ length: 10 }, (_, i) => q(`q${i}`, 0));
    const sel = (n: number) => new Map(questions.slice(0, n).map((x) => [x.tvqId, 0] as [string, number]));
    const at = (n: number) => scoreAttempt({ ...base, questions, selections: sel(n), qualifyingPct: 33, qualifyingPctReserved: 23 });
    expect(at(2)).toMatchObject({ qualifiedGeneral: false, qualifiedReserved: false }); // 20%
    expect(at(3)).toMatchObject({ qualifiedGeneral: false, qualifiedReserved: true }); // 30%
    expect(at(4)).toMatchObject({ qualifiedGeneral: true, qualifiedReserved: true }); // 40%
    expect(scoreAttempt({ ...base, questions, selections: sel(4) }).qualifiedGeneral).toBeNull(); // not a qualifying paper
  });

  it('empty test does not divide by zero', () => {
    expect(scoreAttempt({ ...base, questions: [], selections: new Map() })).toMatchObject({ score: 0, maxScore: 0, accuracyPct: 0 });
  });
});

describe('percentileOf', () => {
  it('is the share of other attempters beaten', () => {
    expect(percentileOf(1, 100)).toBe(100);
    expect(percentileOf(100, 100)).toBe(0);
    expect(percentileOf(2, 3)).toBe(50);
    expect(percentileOf(1, 1)).toBe(100);
  });
});
