/**
 * Consecutive IST days with at least one finished test, counted back from today.
 * A student who has not practised yet today keeps yesterday's streak until the day ends.
 */
export function currentStreak(activeDays: string[], today: string): { current: number; activeToday: boolean } {
  const set = new Set(activeDays);
  const activeToday = set.has(today);
  const day = (ymd: string, back: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() - back * 86_400_000).toISOString().slice(0, 10);
  let cursor = activeToday ? today : day(today, 1);
  let n = 0;
  while (set.has(cursor)) {
    n++;
    cursor = day(cursor, 1);
  }
  return { current: n, activeToday };
}
