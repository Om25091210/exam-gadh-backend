import { rng, sample } from './pick';

describe('seeded picking', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `q${String(i).padStart(2, '0')}`);

  it('is repeatable for the same seed and different for another', () => {
    const a = sample(ids, 10, rng('seed-1'));
    expect(sample([...ids].reverse(), 10, rng('seed-1'))).toEqual(a); // independent of input order
    expect(sample(ids, 10, rng('seed-2'))).not.toEqual(a);
  });

  it('never repeats an id and never returns more than exist', () => {
    const p = sample(ids, 20, rng('x'));
    expect(new Set(p).size).toBe(20);
    expect(sample(ids.slice(0, 3), 10, rng('x'))).toHaveLength(3);
  });

  it('is roughly uniform (every id gets picked sometimes)', () => {
    const hits = new Map<string, number>();
    for (let i = 0; i < 400; i++) for (const id of sample(ids, 5, rng(`s${i}`))) hits.set(id, (hits.get(id) ?? 0) + 1);
    expect(hits.size).toBe(50);
    expect(Math.max(...hits.values())).toBeLessThan(60); // expected 40 per id
  });
});
