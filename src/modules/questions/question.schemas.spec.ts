import { questionContentHash, validateQuestionBody } from './question.schemas';

const opts = ['a', 'b', 'c', 'd'];
const hiOpts = ['अ', 'ब', 'स', 'द'];
const okType = (type: Parameters<typeof validateQuestionBody>[0], en: object, hi?: object) => validateQuestionBody(type, { en, ...(hi ? { hi } : {}) });

describe('validateQuestionBody', () => {
  it('accepts a single-correct question in one language and flags the missing translation', () => {
    const r = okType('single', { stem: 'Q?', options: opts });
    expect(r.ok && r.value).toMatchObject({ hasEn: true, hasHi: false });
  });

  it('accepts both languages', () => {
    const r = okType('single', { stem: 'Q?', options: opts }, { stem: 'प्र?', options: hiOpts });
    expect(r.ok && r.value).toMatchObject({ hasEn: true, hasHi: true });
  });

  it('requires at least one language and exactly four options', () => {
    expect(validateQuestionBody('single', {})).toMatchObject({ ok: false });
    const bad = okType('single', { stem: 'Q?', options: ['a', 'b', 'c'] });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.issues[0].path).toBe('en.options');
  });

  it('rejects empty text and over-long text', () => {
    expect(okType('single', { stem: '   ', options: opts }).ok).toBe(false);
    expect(okType('single', { stem: 'x'.repeat(2001), options: opts }).ok).toBe(false);
  });

  it('sanitises on the way in', () => {
    const r = okType('single', { stem: '<b>Q</b>[b]x', options: opts });
    expect(r.ok && r.value.body.en?.stem).toBe('Q[b]x[/b]');
  });

  it('multi-statement needs statements; both languages must have the same count', () => {
    expect(okType('multi_statement', { stem: 'Consider:', options: opts }).ok).toBe(false);
    const mismatch = okType('multi_statement', { stem: 'C:', statements: ['1', '2'], options: opts }, { stem: 'क:', statements: ['१', '२', '३'], options: hiOpts });
    expect(mismatch.ok).toBe(false);
    expect(okType('multi_statement', { stem: 'C:', statements: ['1', '2'], options: opts }).ok).toBe(true);
  });

  it('match needs two lists of equal length', () => {
    expect(okType('match', { stem: 'M', listA: ['a', 'b'], listB: ['1', '2', '3'], options: opts }).ok).toBe(false);
    expect(okType('match', { stem: 'M', listA: ['a', 'b'], listB: ['1', '2'], options: opts }).ok).toBe(true);
  });

  it('assertion-reason needs assertion and reason; stem is optional', () => {
    expect(okType('assertion_reason', { assertion: 'A', options: opts }).ok).toBe(false);
    expect(okType('assertion_reason', { assertion: 'A', reason: 'R', options: opts }).ok).toBe(true);
  });

  it('chronology needs 3 to 6 items', () => {
    expect(okType('chronology', { stem: 'order', items: ['a', 'b'], options: opts }).ok).toBe(false);
    expect(okType('chronology', { stem: 'order', items: ['a', 'b', 'c'], options: opts }).ok).toBe(true);
  });
});

describe('questionContentHash (duplicate detection)', () => {
  const body = (stem: string) => ({ en: { stem, options: opts } });
  it('ignores case, spacing and punctuation', () => {
    expect(questionContentHash('single', body('What is  the capital?'))).toBe(questionContentHash('single', body('what is the capital')));
  });
  it('differs for different questions, options or types', () => {
    expect(questionContentHash('single', body('A'))).not.toBe(questionContentHash('single', body('B')));
    expect(questionContentHash('single', body('A'))).not.toBe(questionContentHash('match', body('A')));
    expect(questionContentHash('single', body('A'))).not.toBe(questionContentHash('single', { en: { stem: 'A', options: ['a', 'b', 'c', 'e'] } }));
  });
});
