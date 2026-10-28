import { currentStreak } from './streak';

describe('currentStreak', () => {
  it('counts consecutive days ending today', () => {
    expect(currentStreak(['2026-10-28', '2026-10-27', '2026-10-26'], '2026-10-28')).toEqual({ current: 3, activeToday: true });
  });
  it('keeps yesterday\'s streak while today is still open', () => {
    expect(currentStreak(['2026-10-27', '2026-10-26'], '2026-10-28')).toEqual({ current: 2, activeToday: false });
  });
  it('breaks after a missed day', () => {
    expect(currentStreak(['2026-10-26', '2026-10-25'], '2026-10-28')).toEqual({ current: 0, activeToday: false });
    expect(currentStreak(['2026-10-28', '2026-10-26'], '2026-10-28')).toEqual({ current: 1, activeToday: true });
  });
  it('handles month and year boundaries and no activity', () => {
    expect(currentStreak(['2027-01-01', '2026-12-31', '2026-12-30'], '2027-01-01').current).toBe(3);
    expect(currentStreak([], '2026-10-28')).toEqual({ current: 0, activeToday: false });
  });
});
