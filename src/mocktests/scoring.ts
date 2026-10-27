export interface ScoreInput {
  correctMarks: number;
  negativeFraction: number;
  /** question id -> correct option index */
  key: Map<string, number>;
  /** question id -> selected option index (absent / null = not attempted) */
  selections: Map<string, number | null>;
}

export interface ScoreResult {
  score: number;
  maxScore: number;
  correct: number;
  wrong: number;
  unattempted: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Negative marking: each wrong answer costs correctMarks * negativeFraction; skips cost nothing. */
export function scoreAttempt(input: ScoreInput): ScoreResult {
  let correct = 0;
  let wrong = 0;
  let unattempted = 0;
  for (const [qid, answer] of input.key) {
    const sel = input.selections.get(qid);
    if (sel === undefined || sel === null) unattempted++;
    else if (sel === answer) correct++;
    else wrong++;
  }
  const penalty = input.correctMarks * input.negativeFraction;
  return {
    score: round2(correct * input.correctMarks - wrong * penalty),
    maxScore: round2(input.key.size * input.correctMarks),
    correct,
    wrong,
    unattempted,
  };
}
