import ExcelJS from 'exceljs';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { csvSafe } from '../../common/rich-text';
import { prepareQuestion, PreparedQuestion, questionInput } from '../questions/question-input';
import { QuestionBody } from '../questions/question.schemas';

export const MAX_ROWS = 5000;
const LISTSEP = '||';

const LANG_FIELDS = ['stem', 'option_a', 'option_b', 'option_c', 'option_d', 'explanation', 'statements', 'prompt', 'list_a', 'list_b', 'assertion', 'reason', 'items'] as const;
export const COLUMNS = [
  'code', 'type', 'topic', 'subtopic', 'difficulty', 'answer', 'source', 'pyq_year', 'pyq_exam', 'pyq_paper', 'tags',
  'passage_ref', 'passage_en', 'passage_hi',
  ...LANG_FIELDS.map((f) => `en_${f}`),
  ...LANG_FIELDS.map((f) => `hi_${f}`),
] as const;

export interface RowIssue {
  row: number;
  field?: string;
  message: string;
}

export type RawRow = Record<string, string>;

const norm = (k: string) => k.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Cell text for any ExcelJS value (rich text, formulas, numbers, dates). */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return String(v.result ?? '');
    if ('text' in v) return String((v as { text: string }).text);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}

export function parseCsv(buf: Buffer): RawRow[] {
  const records = parseCsvSync(buf, { columns: (h: string[]) => h.map(norm), bom: true, skip_empty_lines: true, trim: true, relax_column_count: true }) as RawRow[];
  return records;
}

export async function parseXlsx(buf: Buffer): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers: string[] = [];
  ws.getRow(1).eachCell((c, i) => (headers[i] = norm(cellText(c.value))));
  const rows: RawRow[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const r: RawRow = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const t = cellText(row.getCell(i).value).trim();
      if (t) any = true;
      r[h] = t;
    });
    if (any) rows.push(r);
  });
  return rows;
}

export async function parseQuestionFile(buf: Buffer, fileName: string): Promise<RawRow[]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx')) {
    if (buf.subarray(0, 2).toString('latin1') !== 'PK') throw new Error('not a valid .xlsx file');
    return parseXlsx(buf);
  }
  if (lower.endsWith('.csv')) {
    if (buf.includes(0)) throw new Error('not a text CSV file');
    return parseCsv(buf);
  }
  throw new Error('only .csv and .xlsx files are accepted');
}

const clean = (s: string | undefined) => (s && s.trim() !== '' ? s.trim() : undefined);
const list = (s: string | undefined) => (clean(s) ? clean(s)!.split(LISTSEP).map((x) => x.trim()).filter(Boolean) : undefined);

function parseAnswer(s: string | undefined): number | undefined {
  const v = clean(s)?.toUpperCase();
  if (!v) return undefined;
  if (/^[A-D]$/.test(v)) return v.charCodeAt(0) - 65;
  if (/^[1-4]$/.test(v)) return Number(v) - 1;
  return undefined;
}

function parseDifficulty(s: string | undefined): number | undefined {
  const v = clean(s)?.toLowerCase();
  if (!v) return undefined;
  if (v === 'easy') return 1;
  if (v === 'medium') return 2;
  if (v === 'hard') return 3;
  return /^[1-3]$/.test(v) ? Number(v) : undefined;
}

/** Column names an issue path maps to, so errors point at the cell the admin must fix. */
function fieldToColumn(path: string): string {
  const m = /^(en|hi)\.(.+)$/.exec(path);
  if (!m) return path;
  const [, lang, rest] = m;
  const opt = /^options(?:\.(\d))?$/.exec(rest);
  if (opt) return opt[1] ? `${lang}_option_${'abcd'[Number(opt[1])]}` : `${lang}_option_a..d`;
  const snake = rest.replace(/^listA/, 'list_a').replace(/^listB/, 'list_b').split('.')[0];
  return `${lang}_${snake}`;
}

export interface MappedRow {
  row: number;
  prepared?: PreparedQuestion;
  passageRef?: string;
  issues: RowIssue[];
}

export function mapRow(raw: RawRow, rowNo: number): MappedRow {
  const issues: RowIssue[] = [];
  const fail = (field: string, message: string) => issues.push({ row: rowNo, field, message });

  const type = (clean(raw.type) ?? 'single').toLowerCase();
  const answer = parseAnswer(raw.answer);
  if (answer === undefined) fail('answer', 'must be A, B, C or D (or 1-4)');
  const difficulty = parseDifficulty(raw.difficulty);
  if (clean(raw.difficulty) && difficulty === undefined) fail('difficulty', 'must be 1, 2, 3 or easy/medium/hard');
  if (!clean(raw.topic)) fail('topic', 'is required');
  const year = clean(raw.pyq_year) ? Number(raw.pyq_year) : undefined;
  if (clean(raw.pyq_year) && !Number.isInteger(year)) fail('pyq_year', 'must be a year');

  const body: Record<string, QuestionBody['en']> = {};
  for (const lang of ['en', 'hi'] as const) {
    const get = (f: string) => clean(raw[`${lang}_${f}`]);
    if (!LANG_FIELDS.some((f) => get(f))) continue;
    const o: Record<string, unknown> = { options: ['a', 'b', 'c', 'd'].map((x) => get(`option_${x}`) ?? ''), stem: get('stem'), explanation: get('explanation'), prompt: get('prompt'), assertion: get('assertion'), reason: get('reason') };
    const statements = list(raw[`${lang}_statements`]);
    const listA = list(raw[`${lang}_list_a`]);
    const listB = list(raw[`${lang}_list_b`]);
    const items = list(raw[`${lang}_items`]);
    if (statements) o.statements = statements;
    if (listA) o.listA = listA;
    if (listB) o.listB = listB;
    if (items) o.items = items;
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    body[lang] = o as unknown as QuestionBody['en'];
  }

  const passageRef = clean(raw.passage_ref);
  const passage = clean(raw.passage_en) || clean(raw.passage_hi) ? { en: clean(raw.passage_en), hi: clean(raw.passage_hi) } : undefined;
  const parsed = questionInput.safeParse({
    code: clean(raw.code),
    type,
    topicCode: clean(raw.topic) ?? '',
    subtopicCode: clean(raw.subtopic) ?? null,
    difficulty: difficulty ?? 2,
    answer: answer ?? 0,
    body,
    source: clean(raw.source) ?? (year ? 'pyq' : 'original'),
    pyqYear: year ?? null,
    pyqExamId: clean(raw.pyq_exam) ?? null,
    pyqPaperCode: clean(raw.pyq_paper) ?? null,
    tags: (clean(raw.tags) ?? '').split(/[,|]/).map((t) => t.trim()).filter(Boolean),
    // the passage text is attached once per passage_ref (first row that has it); the importer resolves the rest
    ...(type === 'passage' ? { passage: passage ?? { en: '(shared passage)' } } : {}),
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const path = i.path.join('.');
      const top: Record<string, string> = { topicCode: 'topic', subtopicCode: 'subtopic', pyqYear: 'pyq_year', pyqExamId: 'pyq_exam', pyqPaperCode: 'pyq_paper', passage: 'passage_en', passageId: 'passage_ref' };
      const col = top[path] ?? fieldToColumn(path);
      if (!(path === 'answer' && answer === undefined) && !(path === 'topicCode' && !clean(raw.topic))) fail(col, i.message);
    }
    return { row: rowNo, issues };
  }
  const prepared = prepareQuestion(parsed.data);
  if (!prepared.ok) {
    for (const i of prepared.issues) fail(fieldToColumn(i.path), i.message);
    return { row: rowNo, issues };
  }
  if (issues.length) return { row: rowNo, issues };
  if (type === 'passage' && !passage && !passageRef) fail('passage_ref', 'a passage question needs passage text or a passage_ref');
  return { row: rowNo, prepared: prepared.value, passageRef: type === 'passage' ? (passageRef ?? `row-${rowNo}`) : undefined, issues };
}

// ------------------------------------------------------------------ export
const join = (v: unknown) => (Array.isArray(v) ? v.join(LISTSEP) : v == null ? '' : String(v));

export function questionToRow(q: { code: string | null; type: string; topicCode: string; subtopicCode: string | null; difficulty: number; answer: number; source: string; pyqYear: number | null; pyqExamId: string | null; pyqPaperCode: string | null; tags: string[]; body: unknown; passage?: { body: unknown } | null }): RawRow {
  const b = q.body as { en?: Record<string, unknown>; hi?: Record<string, unknown> };
  const p = (q.passage?.body ?? {}) as { en?: string; hi?: string };
  const row: RawRow = {
    code: q.code ?? '', type: q.type, topic: q.topicCode, subtopic: q.subtopicCode ?? '', difficulty: String(q.difficulty), answer: 'ABCD'[q.answer], source: q.source,
    pyq_year: q.pyqYear?.toString() ?? '', pyq_exam: q.pyqExamId ?? '', pyq_paper: q.pyqPaperCode ?? '', tags: q.tags.join(','), passage_ref: '', passage_en: p.en ?? '', passage_hi: p.hi ?? '',
  };
  for (const lang of ['en', 'hi'] as const) {
    const l = b[lang] ?? {};
    const opts = (l.options as string[] | undefined) ?? [];
    Object.assign(row, {
      [`${lang}_stem`]: join(l.stem), [`${lang}_option_a`]: opts[0] ?? '', [`${lang}_option_b`]: opts[1] ?? '', [`${lang}_option_c`]: opts[2] ?? '', [`${lang}_option_d`]: opts[3] ?? '',
      [`${lang}_explanation`]: join(l.explanation), [`${lang}_statements`]: join(l.statements), [`${lang}_prompt`]: join(l.prompt), [`${lang}_list_a`]: join(l.listA), [`${lang}_list_b`]: join(l.listB),
      [`${lang}_assertion`]: join(l.assertion), [`${lang}_reason`]: join(l.reason), [`${lang}_items`]: join(l.items),
    });
  }
  return row;
}

export function writeCsv(rows: RawRow[]): Buffer {
  const out = rows.map((r) => COLUMNS.map((c) => csvSafe(r[c] ?? '')));
  return Buffer.from('﻿' + stringify([COLUMNS as unknown as string[], ...out]), 'utf8'); // BOM so Excel opens Hindi correctly
}

export async function writeXlsx(rows: RawRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('questions');
  ws.addRow([...COLUMNS]);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow(COLUMNS.map((c) => csvSafe(r[c] ?? '')));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const TEMPLATE_ROWS: RawRow[] = [
  { code: 'EXAMPLE-001', type: 'single', topic: 'CG_HIST', subtopic: '', difficulty: '2', answer: 'B', source: 'original', tags: 'sample', en_stem: 'Chhattisgarh became a state in the year:', en_option_a: '1999', en_option_b: '2000', en_option_c: '2001', en_option_d: '2002', en_explanation: 'It was formed on 1 November 2000.', hi_stem: 'छत्तीसगढ़ किस वर्ष राज्य बना?', hi_option_a: '1999', hi_option_b: '2000', hi_option_c: '2001', hi_option_d: '2002', hi_explanation: '1 नवंबर 2000 को।' },
  { code: 'EXAMPLE-002', type: 'multi_statement', topic: 'POLITY', difficulty: '2', answer: 'C', en_stem: 'Consider the statements:', en_statements: 'Statement one||Statement two', en_prompt: 'Which is/are correct?', en_option_a: '1 only', en_option_b: '2 only', en_option_c: 'Both 1 and 2', en_option_d: 'Neither' },
];
