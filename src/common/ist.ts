/** Students are in India: "today" and streaks follow the Asia/Kolkata calendar day, not UTC. */
const IST_MS = 5.5 * 3_600_000;

export const istDateString = (d: Date): string => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);

/** The instant an IST calendar day starts (as a UTC Date). */
export const istDayStart = (ymd: string): Date => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - IST_MS);

export const istDayStartOf = (d: Date): Date => istDayStart(istDateString(d));
