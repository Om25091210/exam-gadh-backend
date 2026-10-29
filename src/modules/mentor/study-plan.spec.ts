import { buildStudyPlan, PlanTopic, studyPlanSchema } from './study-plan';

const topic = (code: string, accuracyPct: number | null = null, weight = 1): PlanTopic => ({ code, nameEn: code, nameHi: `${code}-hi`, weight, accuracyPct });
const NOW = new Date('2026-10-29T00:00:00Z');
const topics = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((c) => topic(c));

describe('buildStudyPlan', () => {
  it('runs from today to the day before the exam and is valid against the schema', () => {
    const p = buildStudyPlan({ today: '2026-10-29', examDate: '2026-12-20', hoursPerDay: 4, topics }, NOW, 'cgpsc');
    expect(p.startDate).toBe('2026-10-29');
    expect(p.endDate).toBe('2026-12-19');
    const dates = p.weeks.flatMap((w) => w.days.map((d) => d.date));
    expect(dates[0]).toBe('2026-10-29');
    expect(dates[dates.length - 1]).toBe('2026-12-19');
    expect(new Set(dates).size).toBe(dates.length);
    expect(() => studyPlanSchema.parse(p)).not.toThrow();
    expect(p.summary.studyMinutes).toBe(p.weeks.flatMap((w) => w.days).reduce((n, d) => n + d.minutes, 0));
  });

  it('never schedules more than the hours per day the student gave', () => {
    const p = buildStudyPlan({ today: '2026-10-29', examDate: '2027-02-01', hoursPerDay: 3, topics }, NOW, 'cgpsc');
    for (const d of p.weeks.flatMap((w) => w.days)) expect(d.minutes).toBeLessThanOrEqual(180);
  });

  it('puts the weakest topics first, and revises them in the last weeks', () => {
    const ts = [topic('STRONG', 90), topic('NEW'), topic('WEAK', 20), topic('MID', 60)];
    const p = buildStudyPlan({ today: '2026-10-29', examDate: '2027-01-14', hoursPerDay: 4, topics: ts }, NOW, 'cgpsc'); // 11 weeks
    expect(p.weeks[0].focus.map((f) => f.topicCode)).toEqual(['WEAK']);
    const revise = p.weeks.filter((w) => w.phase === 'revise');
    expect(revise.length).toBeGreaterThanOrEqual(1);
    expect(p.weeks[p.weeks.length - 1].phase).toBe('revise');
    expect(revise[0].focus.map((f) => f.topicCode)).toContain('WEAK');
    expect(revise[0].days.flatMap((d) => d.tasks).some((t) => t.type === 'study')).toBe(false); // no new topics
  });

  it('every topic is studied once in the learn weeks when there are enough weeks', () => {
    const p = buildStudyPlan({ today: '2026-10-29', examDate: '2027-02-15', hoursPerDay: 4, topics }, NOW, 'cgpsc');
    const studied = new Set(p.weeks.filter((w) => w.phase === 'learn').flatMap((w) => w.days.flatMap((d) => d.tasks)).filter((t) => t.type === 'study').map((t) => t.topicCode));
    expect([...studied].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  });

  it('Saturday is mock day and Sunday is rest', () => {
    const p = buildStudyPlan({ today: '2026-10-29', examDate: '2026-12-20', hoursPerDay: 4, topics }, NOW, 'cgpsc');
    for (const d of p.weeks.flatMap((w) => w.days)) {
      const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
      if (dow === 6) expect(d.tasks[0].type).toBe('mock');
      if (dow === 0) expect(d.tasks[0].type).toBe('rest');
    }
  });

  it('handles no exam date (12 weeks), an exam tomorrow, a past date, and no topics', () => {
    expect(buildStudyPlan({ today: '2026-10-29', hoursPerDay: 2, topics }, NOW, 'x').summary.weeks).toBe(12);
    const soon = buildStudyPlan({ today: '2026-10-29', examDate: '2026-10-30', hoursPerDay: 2, topics }, NOW, 'x');
    expect(soon.weeks).toHaveLength(1);
    expect(soon.weeks[0].days).toHaveLength(1);
    const past = buildStudyPlan({ today: '2026-10-29', examDate: '2026-01-01', hoursPerDay: 2, topics }, NOW, 'x');
    expect(past.weeks[0].days).toHaveLength(1);
    const none = buildStudyPlan({ today: '2026-10-29', examDate: '2026-12-20', hoursPerDay: 2, topics: [] }, NOW, 'x');
    expect(() => studyPlanSchema.parse(none)).not.toThrow();
    expect(none.weeks[0].days.flatMap((d) => d.tasks).length).toBeGreaterThan(0);
  });

  it('caps very distant exams at 26 weeks', () => {
    const p = buildStudyPlan({ today: '2026-10-29', examDate: '2029-01-01', hoursPerDay: 4, topics }, NOW, 'x');
    expect(p.weeks).toHaveLength(26);
    expect(() => studyPlanSchema.parse(p)).not.toThrow();
  });
});
