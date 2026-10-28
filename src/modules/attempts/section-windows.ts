export interface SectionTiming {
  position: number;
  durationMin: number | null;
}

export interface SectionWindow {
  position: number;
  start: Date;
  end: Date;
}

/**
 * Sectional timers: sections run one after another. A section ends when its time is up or the student
 * moves on early (recorded in `starts`, keyed by section position). Going back is not allowed.
 */
export function sectionWindows(attemptStart: Date, sections: SectionTiming[], starts: Record<string, string> | null): SectionWindow[] {
  const out: SectionWindow[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const explicit = starts?.[String(s.position)];
    const start = explicit ? new Date(explicit) : i === 0 ? attemptStart : out[i - 1].end;
    const natural = new Date(start.getTime() + (s.durationMin ?? 0) * 60_000);
    const nextExplicit = sections[i + 1] ? starts?.[String(sections[i + 1].position)] : undefined;
    const end = nextExplicit && new Date(nextExplicit) < natural ? new Date(nextExplicit) : natural;
    out.push({ position: s.position, start, end });
  }
  return out;
}

/** The section open at `now`, or null when every section is over. */
export function openSection(windows: SectionWindow[], now: Date): SectionWindow | null {
  return windows.find((w) => now >= w.start && now < w.end) ?? null;
}

export function totalSectionalMinutes(sections: SectionTiming[]): number {
  return sections.reduce((n, s) => n + (s.durationMin ?? 0), 0);
}
