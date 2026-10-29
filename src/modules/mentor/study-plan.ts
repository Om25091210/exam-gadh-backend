import { z } from 'zod';

export interface PlanTopic {
  code: string;
  nameEn: string;
  nameHi: string;
  weight: number;
  /** null = the student has not answered enough questions on this topic to judge */
  accuracyPct: number | null;
}

export interface PlanInput {
  /** IST calendar day, YYYY-MM-DD */
  today: string;
  examDate?: string | null;
  hoursPerDay: number;
  topics: PlanTopic[];
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const task = z.object({
  type: z.enum(['study', 'practice', 'revision', 'mock', 'rest']),
  topicCode: z.string().max(60).optional(),
  minutes: z.number().int().min(0).max(720),
  titleEn: z.string().max(200),
  titleHi: z.string().max(200),
});
const day = z.object({ date: dateStr, minutes: z.number().int().min(0).max(1440), tasks: z.array(task).max(12) });
const week = z.object({
  week: z.number().int().min(1).max(30),
  startDate: dateStr,
  phase: z.enum(['learn', 'revise']),
  focus: z.array(z.object({ topicCode: z.string().max(60), nameEn: z.string().max(200), nameHi: z.string().max(200) })).max(20),
  days: z.array(day).max(7),
  noteEn: z.string().max(1000).optional(),
  noteHi: z.string().max(1000).optional(),
});
export const studyPlanSchema = z.object({
  version: z.literal(1).default(1),
  generatedAt: z.string().max(40),
  examId: z.string().max(40),
  hoursPerDay: z.number().min(0.5).max(16),
  startDate: dateStr,
  endDate: dateStr,
  weeks: z.array(week).min(1).max(30),
  summary: z.object({ weeks: z.number().int(), studyMinutes: z.number().int() }),
});
export type StudyPlan = z.infer<typeof studyPlanSchema>;

const DAY_MS = 86_400_000;
const addDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
const diffDays = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / DAY_MS);
const dow = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const five = (m: number) => Math.max(0, Math.round(m / 5) * 5);

export const DEFAULT_WEEKS = 12;
export const MAX_WEEKS = 26;

/** Weaker topics first; topics with no data are treated as average so a new student gets the syllabus order. */
const priority = (t: PlanTopic) => t.weight * (t.accuracyPct == null ? 1 : t.accuracyPct < 50 ? 2 : t.accuracyPct < 75 ? 1.3 : 0.7);

/**
 * A deterministic, rule-based weekly plan from today to the day before the exam.
 * Learn weeks cover topics weakest-first; the last ~20% of the time is revision of the weakest topics plus mock tests.
 * Saturday is mock-test day, Sunday is rest (light revision only). A mentor reviews and edits it before it is sent.
 */
export function buildStudyPlan(i: PlanInput, now: Date, examId: string): StudyPlan {
  const wanted = i.examDate ? addDays(i.examDate, -1) : addDays(i.today, DEFAULT_WEEKS * 7 - 1);
  const lastDay = wanted < i.today ? i.today : wanted; // an exam today or in the past still gets one day
  const span = Math.max(1, Math.min(MAX_WEEKS * 7, diffDays(i.today, lastDay) + 1));
  const weekCount = Math.ceil(span / 7);
  const reviseWeeks = weekCount >= 4 ? Math.max(1, Math.round(weekCount * 0.2)) : 0;
  const learnWeeks = weekCount - reviseWeeks;
  const topics = [...i.topics].sort((a, b) => priority(b) - priority(a) || a.code.localeCompare(b.code));
  const weakest = topics.slice(0, Math.min(5, topics.length));
  const dayMinutes = Math.round(i.hoursPerDay * 60);
  const focusFor = (w: number): PlanTopic[] => {
    if (!topics.length) return [];
    if (w >= learnWeeks) return weakest; // revision weeks
    if (topics.length <= learnWeeks) return [topics[w % topics.length]];
    const per = topics.length / learnWeeks;
    return topics.slice(Math.floor(w * per), Math.floor((w + 1) * per));
  };
  const ref = (t: PlanTopic) => ({ topicCode: t.code, nameEn: t.nameEn, nameHi: t.nameHi });

  const weeks: StudyPlan['weeks'] = [];
  let total = 0;
  for (let w = 0; w < weekCount; w++) {
    const phase = w >= learnWeeks ? 'revise' : 'learn';
    const focus = focusFor(w);
    const prev = w > 0 ? focusFor(w - 1) : [];
    const days: StudyPlan['weeks'][number]['days'] = [];
    for (let d = 0; d < 7; d++) {
      const date = addDays(i.today, w * 7 + d);
      if (date > lastDay) break;
      const tasks: StudyPlan['weeks'][number]['days'][number]['tasks'] = [];
      const dw = dow(date);
      const pick = (arr: PlanTopic[], k: number) => (arr.length ? arr[k % arr.length] : undefined);
      if (dw === 0) {
        tasks.push({ type: 'rest', minutes: 0, titleEn: 'Rest day', titleHi: 'विश्राम का दिन' });
        const t = pick(focus, d);
        if (t) tasks.push({ type: 'revision', topicCode: t.code, minutes: five(Math.min(30, dayMinutes)), titleEn: `Light revision: ${t.nameEn}`, titleHi: `हल्का पुनरावृत्ति: ${t.nameHi}` });
      } else if (dw === 6) {
        const mock = five(Math.min(180, Math.round(dayMinutes * 0.7)));
        tasks.push({ type: 'mock', minutes: mock, titleEn: 'Full-length mock test', titleHi: 'पूर्ण-लंबाई मॉक टेस्ट' });
        tasks.push({ type: 'revision', minutes: five(dayMinutes - mock), titleEn: 'Review every wrong answer from the mock', titleHi: 'मॉक के हर गलत उत्तर की समीक्षा करें' });
      } else if (phase === 'learn') {
        const t = pick(focus, d);
        if (t) {
          tasks.push({ type: 'study', topicCode: t.code, minutes: five(dayMinutes * 0.6), titleEn: `Study: ${t.nameEn}`, titleHi: `अध्ययन: ${t.nameHi}` });
          tasks.push({ type: 'practice', topicCode: t.code, minutes: five(dayMinutes * 0.25), titleEn: `Practice questions: ${t.nameEn}`, titleHi: `अभ्यास प्रश्न: ${t.nameHi}` });
        } else {
          tasks.push({ type: 'study', minutes: five(dayMinutes * 0.85), titleEn: 'Study from your notes', titleHi: 'अपने नोट्स से अध्ययन' });
        }
        const r = pick(prev, d);
        if (r) tasks.push({ type: 'revision', topicCode: r.code, minutes: five(dayMinutes * 0.15), titleEn: `Revise last week: ${r.nameEn}`, titleHi: `पिछले सप्ताह की पुनरावृत्ति: ${r.nameHi}` });
      } else {
        const t = pick(focus, d);
        if (t) {
          tasks.push({ type: 'revision', topicCode: t.code, minutes: five(dayMinutes * 0.5), titleEn: `Revise weak topic: ${t.nameEn}`, titleHi: `कमज़ोर विषय की पुनरावृत्ति: ${t.nameHi}` });
          tasks.push({ type: 'practice', topicCode: t.code, minutes: five(dayMinutes * 0.5), titleEn: `Timed practice: ${t.nameEn}`, titleHi: `समयबद्ध अभ्यास: ${t.nameHi}` });
        } else {
          tasks.push({ type: 'revision', minutes: five(dayMinutes), titleEn: 'Revise your notes', titleHi: 'अपने नोट्स दोहराएँ' });
        }
      }
      const minutes = tasks.reduce((n, x) => n + x.minutes, 0);
      total += minutes;
      days.push({ date, minutes, tasks });
    }
    weeks.push({
      week: w + 1, startDate: addDays(i.today, w * 7), phase, focus: focus.map(ref), days,
      ...(phase === 'revise' ? { noteEn: 'Revision weeks: weakest topics and mock tests only. No new topics.', noteHi: 'पुनरावृत्ति सप्ताह: केवल कमज़ोर विषय और मॉक टेस्ट। कोई नया विषय नहीं।' } : {}),
    });
  }
  return { version: 1, generatedAt: now.toISOString(), examId, hoursPerDay: i.hoursPerDay, startDate: i.today, endDate: weeks[weeks.length - 1].days.at(-1)?.date ?? i.today, weeks, summary: { weeks: weekCount, studyMinutes: total } };
}
