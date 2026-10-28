import { buildInsights, InsightInput } from './recommendations';

const t = (code: string, attempted: number, correct: number) => ({ code, nameEn: code, nameHi: `${code}-hi`, attempted, correct });
const base: InsightInput = { topics: [], totalAttempted: 100, wrongAnswers: 0, rushedWrong: 0, grossMarks: 100, negativeDeducted: 0 };

describe('buildInsights', () => {
  it('with too little data only suggests a diagnostic', () => {
    const r = buildInsights({ ...base, totalAttempted: 5, topics: [t('A', 5, 0)] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'get_started', action: { type: 'take_diagnostic' } });
    expect(r[0].messageEn).toContain('answered 5');
  });

  it('names the weakest topics first, with numbers from the data, in both languages', () => {
    const r = buildInsights({ ...base, topics: [t('POLITY', 20, 4), t('HIST', 10, 4), t('GEO', 10, 9), t('TINY', 2, 0)] });
    const weak = r.filter((x) => x.kind === 'weak_topic');
    expect(weak.map((w) => w.topicCode)).toEqual(['POLITY', 'HIST']); // TINY has too few answers to judge
    expect(weak[0].messageEn).toContain('20%');
    expect(weak[0].messageHi).toContain('POLITY-hi');
    expect(weak[0].action).toEqual({ type: 'practice_topic', topicCode: 'POLITY' });
  });

  it('flags rushing only when it is common among wrong answers', () => {
    expect(buildInsights({ ...base, wrongAnswers: 20, rushedWrong: 4 }).some((x) => x.kind === 'rushing')).toBe(false);
    expect(buildInsights({ ...base, wrongAnswers: 20, rushedWrong: 10 }).find((x) => x.kind === 'rushing')?.messageEn).toContain('50%');
    expect(buildInsights({ ...base, wrongAnswers: 4, rushedWrong: 4 }).some((x) => x.kind === 'rushing')).toBe(false); // too few wrong answers
  });

  it('shows what negative marking cost, and the strongest topic', () => {
    const r = buildInsights({ ...base, negativeDeducted: 25, topics: [t('GEO', 10, 9)] });
    expect(r.find((x) => x.kind === 'negative_marking')?.messageEn).toContain('25%');
    expect(r.find((x) => x.kind === 'strong')?.topicCode).toBe('GEO');
    expect(buildInsights({ ...base, negativeDeducted: 5 }).some((x) => x.kind === 'negative_marking')).toBe(false);
  });
});
