import ExcelJS from 'exceljs';
import { COLUMNS, mapRow, parseCsv, parseQuestionFile, parseXlsx, questionToRow, TEMPLATE_ROWS, writeCsv, writeXlsx } from './question-sheet';

const row = (o: Record<string, string>) => ({ topic: 'T1', answer: 'B', en_stem: 'Q?', en_option_a: 'a', en_option_b: 'b', en_option_c: 'c', en_option_d: 'd', ...o });

describe('question sheet parsing', () => {
  it('reads CSV with BOM, quoted commas/newlines and Devanagari', () => {
    const csv = '﻿topic,answer,en_stem,hi_stem\nT1,B,"Capital, of ""CG""?\nline two",छत्तीसगढ़\n';
    const rows = parseCsv(Buffer.from(csv, 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0].en_stem).toBe('Capital, of "CG"?\nline two');
    expect(rows[0].hi_stem).toBe('छत्तीसगढ़');
  });

  it('normalises header names (case, spaces, dashes)', () => {
    const rows = parseCsv(Buffer.from('Topic, Answer ,EN Stem\nT1,B,x\n'));
    expect(Object.keys(rows[0])).toEqual(['topic', 'answer', 'en_stem']);
  });

  it('round-trips through XLSX including rich text-free cells and Hindi', async () => {
    const buf = await writeXlsx(TEMPLATE_ROWS);
    const rows = await parseXlsx(buf);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ code: 'EXAMPLE-001', hi_stem: 'छत्तीसगढ़ किस वर्ष राज्य बना?', answer: 'B' });
  });

  it('reads an XLSX written by someone else (numbers become text)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.addRow(['topic', 'answer', 'difficulty', 'en_stem']);
    ws.addRow(['T1', 'A', 2, 'Q']);
    const rows = await parseXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(rows[0]).toEqual({ topic: 'T1', answer: 'A', difficulty: '2', en_stem: 'Q' });
  });

  it('rejects wrong extensions and fake files', async () => {
    await expect(parseQuestionFile(Buffer.from('x'), 'q.txt')).rejects.toThrow(/only .csv and .xlsx/);
    await expect(parseQuestionFile(Buffer.from('not a zip'), 'q.xlsx')).rejects.toThrow(/valid .xlsx/);
    await expect(parseQuestionFile(Buffer.from([0, 1, 2]), 'q.csv')).rejects.toThrow(/text CSV/);
  });
});

describe('mapRow', () => {
  it('maps a single-correct row (answer letter or number, difficulty word or number)', () => {
    const a = mapRow(row({ difficulty: 'hard' }), 2);
    expect(a.issues).toEqual([]);
    expect(a.prepared?.data).toMatchObject({ type: 'single', answer: 1, difficulty: 3, topicCode: 'T1', hasEn: true, hasHi: false });
    expect(mapRow(row({ answer: '3' }), 2).prepared?.data.answer).toBe(2);
  });

  it('maps list-type fields separated by ||', () => {
    const m = mapRow(row({ type: 'multi_statement', en_statements: 'One||Two||Three' }), 5);
    expect(m.issues).toEqual([]);
    expect((m.prepared?.data.body.en as unknown as { statements: string[] }).statements).toEqual(['One', 'Two', 'Three']);
    const mt = mapRow(row({ type: 'match', en_list_a: 'a||b', en_list_b: '1||2' }), 6);
    expect(mt.issues).toEqual([]);
  });

  it('points errors at the exact column and row', () => {
    const noAnswer = mapRow(row({ answer: 'Z' }), 7);
    expect(noAnswer.issues).toEqual([{ row: 7, field: 'answer', message: 'must be A, B, C or D (or 1-4)' }]);
    const shortOptions = mapRow(row({ en_option_d: '' }), 8);
    expect(shortOptions.issues.some((i) => i.row === 8 && i.field === 'en_option_d')).toBe(true);
    expect(mapRow(row({ en_stem: '' }), 9).issues.some((i) => i.field === 'en_stem')).toBe(true);
    expect(mapRow(row({ type: 'bogus' }), 10).issues.some((i) => i.field === 'type')).toBe(true);
    expect(mapRow(row({ topic: '' }), 11).issues.some((i) => i.field === 'topic')).toBe(true);
    expect(mapRow(row({ difficulty: '9' }), 12).issues[0]).toMatchObject({ field: 'difficulty' });
    expect(mapRow(row({ type: 'chronology', en_items: 'a||b' }), 13).issues.some((i) => i.field === 'en_items')).toBe(true);
  });

  it('requires pyq year for previous-year questions and a passage for passage questions', () => {
    expect(mapRow(row({ source: 'pyq' }), 2).issues.some((i) => i.field === 'pyq_year')).toBe(true);
    expect(mapRow(row({ pyq_year: '2022' }), 2).prepared?.data).toMatchObject({ source: 'pyq', pyqYear: 2022 });
    expect(mapRow(row({ type: 'passage' }), 3).issues.length).toBeGreaterThan(0);
    expect(mapRow(row({ type: 'passage', passage_en: 'Some passage' }), 3).issues).toEqual([]);
  });

  it('strips markup on the way in', () => {
    const m = mapRow(row({ en_stem: 'Hello <img src=x onerror=1> [b]world' }), 2);
    expect(m.prepared?.data.body.en?.stem).toBe('Hello [b]world[/b]');
  });
});

describe('export', () => {
  it('writes every column and neutralises spreadsheet formulas', () => {
    const csv = writeCsv([{ ...questionToRow({ code: 'C1', type: 'single', topicCode: 'T1', subtopicCode: null, difficulty: 2, answer: 1, source: 'original', pyqYear: null, pyqExamId: null, pyqPaperCode: null, tags: ['a', 'b'], body: { en: { stem: '=HYPERLINK("http://evil")', options: ['a', 'b', 'c', 'd'] } } }) }]).toString('utf8');
    expect(csv.split('\n')[0]).toBe('﻿' + COLUMNS.join(','));
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });
});
