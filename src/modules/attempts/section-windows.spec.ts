import { openSection, sectionWindows, totalSectionalMinutes } from './section-windows';

const t0 = new Date('2026-11-01T10:00:00Z');
const secs = [{ position: 0, durationMin: 10 }, { position: 1, durationMin: 20 }, { position: 2, durationMin: 5 }];
const at = (min: number) => new Date(t0.getTime() + min * 60_000);

describe('section windows', () => {
  it('runs sections back to back when nobody advances early', () => {
    const w = sectionWindows(t0, secs, null);
    expect(w.map((x) => [x.position, x.start.getTime() - t0.getTime(), x.end.getTime() - t0.getTime()])).toEqual([
      [0, 0, 600_000],
      [1, 600_000, 1_800_000],
      [2, 1_800_000, 2_100_000],
    ]);
    expect(totalSectionalMinutes(secs)).toBe(35);
  });

  it('finds the open section by time', () => {
    const w = sectionWindows(t0, secs, null);
    expect(openSection(w, at(5))?.position).toBe(0);
    expect(openSection(w, at(10))?.position).toBe(1);
    expect(openSection(w, at(34.9))?.position).toBe(2);
    expect(openSection(w, at(35))).toBeNull();
  });

  it('moving on early closes the section right away and starts the next one then', () => {
    const w = sectionWindows(t0, secs, { '0': t0.toISOString(), '1': at(4).toISOString() });
    expect(w[0].end).toEqual(at(4));
    expect(w[1].start).toEqual(at(4));
    expect(w[1].end).toEqual(at(24));
    expect(openSection(w, at(3))?.position).toBe(0);
    expect(openSection(w, at(4))?.position).toBe(1);
  });
});
