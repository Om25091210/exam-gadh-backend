/**
 * Idempotent bootstrap data. Everything here is SAMPLE or a starting default:
 * - exam patterns come from the owner's prototype app configuration and are flagged `patternVerified=false`
 *   until an admin confirms them against the current official notification;
 * - questions are samples (one of each type) so a fresh environment is usable. Real content arrives through
 *   the admin bulk import.
 */
import { AccessLevel, PrismaClient, QuestionType, TestKind } from '@prisma/client';
import { validateQuestionBody } from '../src/modules/questions/question.schemas';
import { publishTestVersion } from '../src/modules/tests/test-publishing';

const prisma = new PrismaClient();
const NOTE = 'Starting default from the prototype app configuration. Verify against the current official notification.';

const exams = [
  { id: 'cgpsc', nameEn: 'CGPSC State Service (Prelims)', nameHi: 'CGPSC राज्य सेवा (प्रारंभिक)', shortEn: 'CGPSC', shortHi: 'CGPSC', hasMains: true },
  { id: 'si', nameEn: 'Police Sub-Inspector (SI)', nameHi: 'पुलिस उप निरीक्षक (SI)', shortEn: 'SI', shortHi: 'SI' },
  { id: 'patwari', nameEn: 'Patwari', nameHi: 'पटवारी', shortEn: 'Patwari', shortHi: 'पटवारी' },
  { id: 'mandi', nameEn: 'Mandi Inspector', nameHi: 'मंडी निरीक्षक', shortEn: 'Mandi', shortHi: 'मंडी' },
  { id: 'food', nameEn: 'Food Inspector', nameHi: 'खाद्य निरीक्षक', shortEn: 'Food', shortHi: 'खाद्य' },
  { id: 'other', nameEn: 'Other Exams', nameHi: 'अन्य परीक्षाएँ', shortEn: 'Other', shortHi: 'अन्य' },
];

const subjects = [
  { code: 'CGGK', nameEn: 'Chhattisgarh GK', nameHi: 'छत्तीसगढ़ सामान्य ज्ञान', topics: [['CG_HIST', 'CG History', 'छत्तीसगढ़ का इतिहास', [['CG_HIST_FORM', 'Formation of the state', 'राज्य का गठन']]], ['CG_GEO', 'CG Geography', 'छत्तीसगढ़ का भूगोल', [['CG_GEO_RIVERS', 'Rivers', 'नदियाँ']]]] },
  { code: 'POL', nameEn: 'Polity', nameHi: 'राजव्यवस्था', topics: [['POLITY', 'Indian Constitution & Polity', 'भारतीय संविधान एवं राजव्यवस्था', [['POLITY_PARTS', 'Parts and Articles', 'भाग एवं अनुच्छेद']]]] },
  { code: 'HIST', nameEn: 'History', nameHi: 'इतिहास', topics: [['HIST_MOD', 'Modern India', 'आधुनिक भारत', [['HIST_MOD_FREEDOM', 'Freedom movement', 'स्वतंत्रता आंदोलन']]]] },
  { code: 'GEO', nameEn: 'Geography', nameHi: 'भूगोल', topics: [['GEO_IND', 'Indian Geography', 'भारत का भूगोल', []]] },
  { code: 'CULT', nameEn: 'Culture', nameHi: 'संस्कृति', topics: [['CG_CULT', 'CG Culture', 'छत्तीसगढ़ की संस्कृति', []]] },
] as const;

type Lang = Record<string, unknown>;
interface Q {
  code: string;
  type: QuestionType;
  topic: string;
  subtopic?: string;
  answer: number;
  difficulty?: number;
  en: Lang;
  hi: Lang;
  passage?: { en: string; hi: string };
}

const STD_AR = ['Both A and R are true and R is the correct explanation of A', 'Both A and R are true but R is not the correct explanation of A', 'A is true but R is false', 'A is false but R is true'];
const STD_AR_HI = ['A और R दोनों सत्य हैं तथा R, A की सही व्याख्या है', 'A और R दोनों सत्य हैं किंतु R, A की सही व्याख्या नहीं है', 'A सत्य है किंतु R असत्य है', 'A असत्य है किंतु R सत्य है'];

const questions: Q[] = [
  { code: 'SAMPLE-CGH-01', type: 'single', topic: 'CG_HIST', subtopic: 'CG_HIST_FORM', answer: 0, en: { stem: 'Chhattisgarh became a separate state on:', options: ['1 November 2000', '15 August 1947', '26 January 1950', '2 October 2000'], explanation: 'Chhattisgarh was carved out of Madhya Pradesh on 1 November 2000.' }, hi: { stem: 'छत्तीसगढ़ अलग राज्य कब बना?', options: ['1 नवंबर 2000', '15 अगस्त 1947', '26 जनवरी 1950', '2 अक्टूबर 2000'], explanation: 'छत्तीसगढ़ 1 नवंबर 2000 को मध्य प्रदेश से अलग होकर बना।' } },
  { code: 'SAMPLE-CGG-01', type: 'single', topic: 'CG_GEO', subtopic: 'CG_GEO_RIVERS', answer: 1, en: { stem: 'The principal river of Chhattisgarh is:', options: ['Narmada', 'Mahanadi', 'Godavari', 'Son'], explanation: 'The Mahanadi rises near Sihawa in Dhamtari district and drains most of the state.' }, hi: { stem: 'छत्तीसगढ़ की प्रमुख नदी कौन-सी है?', options: ['नर्मदा', 'महानदी', 'गोदावरी', 'सोन'], explanation: 'महानदी धमतरी जिले के सिहावा के निकट से निकलती है और राज्य के अधिकांश भाग को सींचती है।' } },
  { code: 'SAMPLE-CGC-01', type: 'single', topic: 'CG_CULT', answer: 3, en: { stem: 'The state animal of Chhattisgarh is:', options: ['Tiger', 'Elephant', 'Barasingha', 'Wild buffalo (Van Bhainsa)'], explanation: 'The wild buffalo is the state animal.' }, hi: { stem: 'छत्तीसगढ़ का राजकीय पशु कौन-सा है?', options: ['बाघ', 'हाथी', 'बारहसिंगा', 'वन भैंसा'], explanation: 'वन भैंसा राज्य पशु है।' } },
  { code: 'SAMPLE-POL-01', type: 'single', topic: 'POLITY', subtopic: 'POLITY_PARTS', answer: 2, en: { stem: 'Fundamental Rights are contained in which Part of the Constitution?', options: ['Part I', 'Part II', 'Part III', 'Part IV'], explanation: 'Part III (Articles 12-35) contains the Fundamental Rights.' }, hi: { stem: 'मौलिक अधिकार संविधान के किस भाग में हैं?', options: ['भाग I', 'भाग II', 'भाग III', 'भाग IV'], explanation: 'भाग III (अनुच्छेद 12-35) में मौलिक अधिकार हैं।' } },
  { code: 'SAMPLE-POL-02', type: 'multi_statement', topic: 'POLITY', subtopic: 'POLITY_PARTS', answer: 2, difficulty: 2, en: { stem: 'Consider the following statements about the Constitution of India:', statements: ['Fundamental Rights are in Part III.', 'Directive Principles of State Policy are in Part IV.'], prompt: 'Which of the statements given above is/are correct?', options: ['1 only', '2 only', 'Both 1 and 2', 'Neither 1 nor 2'], explanation: 'Both statements are correct.' }, hi: { stem: 'भारत के संविधान के बारे में निम्नलिखित कथनों पर विचार कीजिए:', statements: ['मौलिक अधिकार भाग III में हैं।', 'राज्य के नीति निदेशक तत्व भाग IV में हैं।'], prompt: 'ऊपर दिए गए कथनों में से कौन-सा/से सही है/हैं?', options: ['केवल 1', 'केवल 2', '1 और 2 दोनों', 'न तो 1 और न ही 2'], explanation: 'दोनों कथन सही हैं।' } },
  { code: 'SAMPLE-POL-03', type: 'match', topic: 'POLITY', subtopic: 'POLITY_PARTS', answer: 0, difficulty: 2, en: { stem: 'Match List-I with List-II:', listA: ['A. Fundamental Rights', 'B. Directive Principles', 'C. Fundamental Duties'], listB: ['1. Part IV', '2. Part III', '3. Part IV-A'], options: ['A-2, B-1, C-3', 'A-1, B-2, C-3', 'A-3, B-1, C-2', 'A-2, B-3, C-1'], explanation: 'Fundamental Rights: Part III; Directive Principles: Part IV; Fundamental Duties: Part IV-A.' }, hi: { stem: 'सूची-I का सूची-II से मिलान कीजिए:', listA: ['A. मौलिक अधिकार', 'B. नीति निदेशक तत्व', 'C. मौलिक कर्तव्य'], listB: ['1. भाग IV', '2. भाग III', '3. भाग IV-क'], options: ['A-2, B-1, C-3', 'A-1, B-2, C-3', 'A-3, B-1, C-2', 'A-2, B-3, C-1'], explanation: 'मौलिक अधिकार: भाग III; नीति निदेशक तत्व: भाग IV; मौलिक कर्तव्य: भाग IV-क।' } },
  { code: 'SAMPLE-CGH-02', type: 'assertion_reason', topic: 'CG_HIST', subtopic: 'CG_HIST_FORM', answer: 0, difficulty: 2, en: { assertion: 'Chhattisgarh was formed out of the state of Madhya Pradesh.', reason: 'The Madhya Pradesh Reorganisation Act, 2000 provided for the creation of Chhattisgarh.', options: STD_AR, explanation: 'The Act provided for the new state, so R explains A.' }, hi: { assertion: 'छत्तीसगढ़ का गठन मध्य प्रदेश राज्य से अलग करके किया गया।', reason: 'मध्य प्रदेश पुनर्गठन अधिनियम, 2000 ने छत्तीसगढ़ के गठन का प्रावधान किया।', options: STD_AR_HI, explanation: 'अधिनियम ने नए राज्य का प्रावधान किया, इसलिए R, A की सही व्याख्या है।' } },
  { code: 'SAMPLE-HIS-01', type: 'chronology', topic: 'HIST_MOD', subtopic: 'HIST_MOD_FREEDOM', answer: 0, difficulty: 2, en: { stem: 'Arrange the following events in chronological order:', items: ['Quit India Movement', 'Dandi March', 'Jallianwala Bagh massacre', 'Non-Cooperation Movement'], options: ['3, 4, 2, 1', '3, 2, 4, 1', '4, 3, 2, 1', '3, 4, 1, 2'], explanation: 'Jallianwala Bagh (1919), Non-Cooperation (1920), Dandi March (1930), Quit India (1942).' }, hi: { stem: 'निम्नलिखित घटनाओं को कालक्रमानुसार व्यवस्थित कीजिए:', items: ['भारत छोड़ो आंदोलन', 'दांडी मार्च', 'जलियाँवाला बाग हत्याकांड', 'असहयोग आंदोलन'], options: ['3, 4, 2, 1', '3, 2, 4, 1', '4, 3, 2, 1', '3, 4, 1, 2'], explanation: 'जलियाँवाला बाग (1919), असहयोग (1920), दांडी मार्च (1930), भारत छोड़ो (1942)।' } },
  { code: 'SAMPLE-CGG-02', type: 'passage', topic: 'CG_GEO', subtopic: 'CG_GEO_RIVERS', answer: 2, passage: { en: 'The Mahanadi rises in the Dhamtari district of Chhattisgarh, flows through Odisha and finally falls into the Bay of Bengal.', hi: 'महानदी छत्तीसगढ़ के धमतरी जिले से निकलती है, ओडिशा से होकर बहती है और अंत में बंगाल की खाड़ी में गिरती है।' }, en: { stem: 'Into which water body does the river described in the passage finally drain?', options: ['Arabian Sea', 'Gulf of Kutch', 'Bay of Bengal', 'Indian Ocean (open ocean)'], explanation: 'The passage states it falls into the Bay of Bengal.' }, hi: { stem: 'गद्यांश में वर्णित नदी अंततः किस जलाशय में गिरती है?', options: ['अरब सागर', 'कच्छ की खाड़ी', 'बंगाल की खाड़ी', 'हिंद महासागर (खुला महासागर)'], explanation: 'गद्यांश के अनुसार यह बंगाल की खाड़ी में गिरती है।' } },
  { code: 'SAMPLE-GEO-01', type: 'single', topic: 'GEO_IND', answer: 0, en: { stem: "India's national animal is:", options: ['Tiger', 'Lion', 'Elephant', 'Leopard'], explanation: 'The Bengal tiger is the national animal.' }, hi: { stem: 'भारत का राष्ट्रीय पशु कौन-सा है?', options: ['बाघ', 'सिंह', 'हाथी', 'तेंदुआ'], explanation: 'बंगाल टाइगर राष्ट्रीय पशु है।' } },
];

async function main() {
  for (const [i, e] of exams.entries()) {
    await prisma.exam.upsert({ where: { id: e.id }, update: {}, create: { ...e, sort: i, patternVerified: false, patternNote: NOTE } });
  }
  // CGPSC Prelims: two papers; Paper II is qualifying only (33%, 23% for reserved categories) per the prototype configuration.
  const papers = [
    { id: 'cgpsc_pre_gs', examId: 'cgpsc', code: 'PRE_GS', nameEn: 'Prelims Paper I: General Studies', nameHi: 'प्रारंभिक प्रश्नपत्र I: सामान्य अध्ययन', questionCount: 100, totalMarks: 200, durationMin: 120, qualifyingPct: null, qualifyingPctReserved: null, countsTowardMerit: true },
    { id: 'cgpsc_pre_csat', examId: 'cgpsc', code: 'PRE_CSAT', nameEn: 'Prelims Paper II: Aptitude Test (CSAT)', nameHi: 'प्रारंभिक प्रश्नपत्र II: योग्यता परीक्षण (CSAT)', questionCount: 100, totalMarks: 200, durationMin: 120, qualifyingPct: 33, qualifyingPctReserved: 23, countsTowardMerit: false },
    ...exams.filter((e) => e.id !== 'cgpsc').map((e) => ({ id: `${e.id}_gen`, examId: e.id, code: 'GEN', nameEn: `${e.shortEn} written test`, nameHi: `${e.shortHi} लिखित परीक्षा`, questionCount: 25, totalMarks: 50, durationMin: 30, qualifyingPct: null, qualifyingPctReserved: null, countsTowardMerit: true })),
  ];
  for (const [i, p] of papers.entries()) {
    await prisma.examPaper.upsert({ where: { id: p.id }, update: {}, create: { ...p, correctMarks: 2, negativeFraction: 1 / 3, sort: i } });
  }
  for (const [i, s] of subjects.entries()) {
    await prisma.subject.upsert({ where: { code: s.code }, update: {}, create: { code: s.code, nameEn: s.nameEn, nameHi: s.nameHi, sort: i } });
    await prisma.paperSubject.upsert({ where: { paperId_subjectCode: { paperId: 'cgpsc_pre_gs', subjectCode: s.code } }, update: {}, create: { paperId: 'cgpsc_pre_gs', subjectCode: s.code, sort: i } });
    for (const [j, [code, en, hi, subs]] of s.topics.entries()) {
      await prisma.topic.upsert({ where: { code }, update: {}, create: { code, subjectCode: s.code, nameEn: en, nameHi: hi, sort: j } });
      for (const [k, [sc, sen, shi]] of subs.entries()) {
        await prisma.subtopic.upsert({ where: { code: sc }, update: {}, create: { code: sc, topicCode: code, nameEn: sen, nameHi: shi, sort: k } });
      }
    }
  }

  const ids: string[] = [];
  for (const q of questions) {
    const v = validateQuestionBody(q.type, { en: q.en, hi: q.hi });
    if (!v.ok) throw new Error(`seed question ${q.code} invalid: ${JSON.stringify(v.issues)}`);
    const already = await prisma.question.findUnique({ where: { code: q.code } });
    if (already) {
      ids.push(already.id);
      continue;
    }
    const passage = q.passage ? await prisma.passage.create({ data: { body: q.passage } }) : null;
    const row = await prisma.question.upsert({
      where: { code: q.code },
      update: {},
      create: { code: q.code, type: q.type, topicCode: q.topic, subtopicCode: q.subtopic, difficulty: q.difficulty ?? 1, status: 'published', body: v.value.body as never, answer: q.answer, passageId: passage?.id, hasEn: v.value.hasEn, hasHi: v.value.hasHi, contentHash: v.value.contentHash, source: 'original', tags: ['sample'] },
    });
    ids.push(row.id);
  }

  async function sampleTest(title: [string, string], kind: TestKind, access: AccessLevel, qids: string[], marker: string) {
    const exists = await prisma.test.findFirst({ where: { titleEn: title[0], examId: 'cgpsc' } });
    if (exists) return;
    await prisma.$transaction(async (tx) => {
      const test = await tx.test.create({ data: { examId: 'cgpsc', paperId: 'cgpsc_pre_gs', titleEn: title[0], titleHi: title[1], kind, access } });
      const v = await tx.testVersion.create({
        data: { testId: test.id, version: 1, durationMin: 15, correctMarks: 2, negativeFraction: 1 / 3, instructionsEn: 'Sample test. Each wrong answer costs one-third of the marks.', instructionsHi: 'नमूना टेस्ट। प्रत्येक गलत उत्तर पर अंक का एक-तिहाई कटेगा।' },
      });
      const sec = await tx.testSection.create({ data: { versionId: v.id, position: 0, nameEn: 'General', nameHi: 'सामान्य' } });
      await tx.testVersionQuestion.createMany({ data: qids.map((questionId, position) => ({ versionId: v.id, sectionId: sec.id, position, questionId, questionVersion: 1 })) });
      await publishTestVersion(tx, v.id);
      void marker;
    });
  }
  await sampleTest(['Sample diagnostic test', 'नमूना डायग्नोस्टिक टेस्ट'], 'diagnostic', 'free', ids, 'free');
  await sampleTest(['Sample paid mock', 'नमूना पेड मॉक'], 'mock', 'paid', ids.slice(0, 5), 'paid');

  await prisma.plan.upsert({ where: { id: 'pass_prelims' }, update: {}, create: { id: 'pass_prelims', nameEn: 'Prelims Pass', nameHi: 'प्रारंभिक पास', prices: { '3': 399, '6': 699, '12': 999 }, trialDays: 7 } });
  await prisma.plan.upsert({ where: { id: 'pass_full' }, update: {}, create: { id: 'pass_full', nameEn: 'Prelims + Mains Pass', nameHi: 'प्रारंभिक + मुख्य पास', prices: { '3': 599, '6': 999, '12': 1499 }, trialDays: 7, topTier: true, exams: { create: [{ examId: 'cgpsc' }] } } });
  console.log('seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
