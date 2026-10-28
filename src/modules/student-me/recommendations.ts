export interface TopicRow {
  code: string;
  nameEn: string;
  nameHi: string;
  attempted: number;
  correct: number;
}

export interface Insight {
  kind: 'weak_topic' | 'rushing' | 'negative_marking' | 'get_started' | 'strong';
  topicCode?: string;
  messageEn: string;
  messageHi: string;
  /** what the client should offer: open a practice set for a topic, or take a diagnostic */
  action?: { type: 'practice_topic' | 'take_diagnostic'; topicCode?: string };
}

export interface InsightInput {
  topics: TopicRow[];
  totalAttempted: number;
  wrongAnswers: number;
  rushedWrong: number; // wrong answers given in 10 seconds or less
  grossMarks: number;
  negativeDeducted: number;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
export const MIN_QUESTIONS_FOR_TOPIC = 5;
export const MIN_QUESTIONS_OVERALL = 20;

/**
 * Plain, rule-based advice computed from the student's real answers. No guesses without data:
 * with too few answers the only advice is to take a diagnostic test.
 */
export function buildInsights(i: InsightInput): Insight[] {
  if (i.totalAttempted < MIN_QUESTIONS_OVERALL) {
    return [{ kind: 'get_started', messageEn: `Answer at least ${MIN_QUESTIONS_OVERALL} questions (a diagnostic test is a good start) to get personal advice. You have answered ${i.totalAttempted}.`, messageHi: `व्यक्तिगत सुझाव पाने के लिए कम से कम ${MIN_QUESTIONS_OVERALL} प्रश्न हल करें (डायग्नोस्टिक टेस्ट अच्छी शुरुआत है)। आपने अब तक ${i.totalAttempted} हल किए हैं।`, action: { type: 'take_diagnostic' } }];
  }
  const out: Insight[] = [];
  const ranked = i.topics.filter((t) => t.attempted >= MIN_QUESTIONS_FOR_TOPIC).map((t) => ({ ...t, acc: pct(t.correct, t.attempted) }));
  const weak = ranked.filter((t) => t.acc < 50).sort((a, b) => a.acc - b.acc).slice(0, 3);
  for (const t of weak) {
    out.push({ kind: 'weak_topic', topicCode: t.code, messageEn: `${t.nameEn}: ${t.acc}% correct over ${t.attempted} questions. Practise this topic next.`, messageHi: `${t.nameHi}: ${t.attempted} प्रश्नों में ${t.acc}% सही। अगला अभ्यास इसी विषय का करें।`, action: { type: 'practice_topic', topicCode: t.code } });
  }
  if (i.wrongAnswers >= 10 && pct(i.rushedWrong, i.wrongAnswers) >= 25) {
    out.push({ kind: 'rushing', messageEn: `${pct(i.rushedWrong, i.wrongAnswers)}% of your wrong answers were given in 10 seconds or less. Read each option before choosing.`, messageHi: `आपके ${pct(i.rushedWrong, i.wrongAnswers)}% गलत उत्तर 10 सेकंड या उससे कम में दिए गए। चुनने से पहले हर विकल्प पढ़ें।` });
  }
  if (i.grossMarks > 0 && pct(i.negativeDeducted, i.grossMarks) >= 10) {
    out.push({ kind: 'negative_marking', messageEn: `Negative marking cost you ${pct(i.negativeDeducted, i.grossMarks)}% of the marks you earned. Skip a question when you are unsure.`, messageHi: `ऋणात्मक अंकन से आपके अर्जित अंकों का ${pct(i.negativeDeducted, i.grossMarks)}% कट गया। अनिश्चित होने पर प्रश्न छोड़ दें।` });
  }
  const best = ranked.filter((t) => t.acc >= 75).sort((a, b) => b.acc - a.acc)[0];
  if (best) out.push({ kind: 'strong', topicCode: best.code, messageEn: `Strongest topic: ${best.nameEn} (${best.acc}%). Keep revising it briefly and spend the time on weaker topics.`, messageHi: `सबसे मज़बूत विषय: ${best.nameHi} (${best.acc}%)। इसे संक्षेप में दोहराते रहें और कमज़ोर विषयों को अधिक समय दें।` });
  return out;
}
