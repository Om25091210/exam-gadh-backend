import { istDateString, istDayStart, istDayStartOf } from './ist';

describe('IST calendar days', () => {
  it('rolls over at 18:30 UTC, not midnight UTC', () => {
    expect(istDateString(new Date('2026-10-27T18:29:59Z'))).toBe('2026-10-27');
    expect(istDateString(new Date('2026-10-27T18:30:00Z'))).toBe('2026-10-28');
    expect(istDateString(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
  });
  it('day start is the matching UTC instant', () => {
    expect(istDayStart('2026-10-28').toISOString()).toBe('2026-10-27T18:30:00.000Z');
    expect(istDayStartOf(new Date('2026-10-28T05:00:00Z')).toISOString()).toBe('2026-10-27T18:30:00.000Z');
  });
});
