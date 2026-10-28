export interface ScoredQuestion {
  tvqId: string;
  answer: number;
  marks: number;
  sectionPos: number;
  topicCode: string;
}

export interface SectionInfo {
  position: number;
  nameEn: string;
  nameHi: string;
}

export interface ScoreInput {
  questions: ScoredQuestion[];
  /** tvq id -> selected option (absent / null = not attempted) */
  selections: Map<string, number | null>;
  /** tvq id -> seconds spent (client reported; used for analytics only, never for marks) */
  times: Map<string, number>;
  negativeFraction: number;
  sections: SectionInfo[];
  qualifyingPct?: number | null;
  qualifyingPctReserved?: number | null;
}

export interface ScoreResult {
  score: number;
  maxScore: number;
  correct: number;
  wrong: number;
  skipped: number;
  negativeDeducted: number;
  accuracyPct: number;
  sectionScores: Array<{ position: number; nameEn: string; nameHi: string; score: number; maxScore: number; correct: number; wrong: number; skipped: number }>;
  topicScores: Record<string, { attempted: number; correct: number; wrong: number; marks: number; timeSec: number }>;
  qualifiedGeneral: boolean | null;
  qualifiedReserved: boolean | null;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Pure scoring. A wrong answer costs `marks * negativeFraction` of that question's marks; skipped questions cost nothing.
 * Qualifying-only papers report whether the percentage reached the (general / reserved) cut-off.
 */
export function scoreAttempt(input: ScoreInput): ScoreResult {
  const sections = new Map<number, ScoreResult['sectionScores'][number]>();
  for (const s of input.sections) {
    sections.set(s.position, { ...s, score: 0, maxScore: 0, correct: 0, wrong: 0, skipped: 0 });
  }
  const topics: ScoreResult['topicScores'] = {};
  let correct = 0;
  let wrong = 0;
  let skipped = 0;
  let marksGained = 0;
  let negative = 0;
  let maxScore = 0;

  for (const q of input.questions) {
    const sel = input.selections.get(q.tvqId);
    maxScore += q.marks;
    const t = (topics[q.topicCode] ??= { attempted: 0, correct: 0, wrong: 0, marks: 0, timeSec: 0 });
    t.timeSec += input.times.get(q.tvqId) ?? 0;
    const sec = sections.get(q.sectionPos) ?? (sections.set(q.sectionPos, { position: q.sectionPos, nameEn: '', nameHi: '', score: 0, maxScore: 0, correct: 0, wrong: 0, skipped: 0 }), sections.get(q.sectionPos)!);
    sec.maxScore += q.marks;

    if (sel === undefined || sel === null) {
      skipped++;
      sec.skipped++;
    } else if (sel === q.answer) {
      correct++;
      marksGained += q.marks;
      sec.correct++;
      sec.score += q.marks;
      t.attempted++;
      t.correct++;
      t.marks += q.marks;
    } else {
      const penalty = q.marks * input.negativeFraction;
      wrong++;
      negative += penalty;
      sec.wrong++;
      sec.score -= penalty;
      t.attempted++;
      t.wrong++;
      t.marks -= penalty;
    }
  }

  const score = round2(marksGained - negative);
  const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;
  const attempted = correct + wrong;
  return {
    score,
    maxScore: round2(maxScore),
    correct,
    wrong,
    skipped,
    negativeDeducted: round2(negative),
    accuracyPct: attempted ? round2((correct / attempted) * 100) : 0,
    sectionScores: [...sections.values()]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ ...s, score: round2(s.score), maxScore: round2(s.maxScore) })),
    topicScores: Object.fromEntries(Object.entries(topics).map(([k, v]) => [k, { ...v, marks: round2(v.marks) }])),
    qualifiedGeneral: input.qualifyingPct == null ? null : pct >= input.qualifyingPct,
    qualifiedReserved: input.qualifyingPctReserved == null ? null : pct >= input.qualifyingPctReserved,
  };
}
