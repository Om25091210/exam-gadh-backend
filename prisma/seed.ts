/**
 * Idempotent bootstrap data: the 6 launch exams, subjects/topics, the two plans and a few SAMPLE
 * questions so a fresh environment is usable. Real content arrives through the admin import.
 */
import { AccessLevel, PrismaClient, TestKind } from '@prisma/client';

const prisma = new PrismaClient();

const exams = [
  { id: 'cgpsc', nameEn: 'CGPSC State Service (Prelims)', nameHi: 'CGPSC राज्य सेवा (प्रारंभिक)', shortEn: 'CGPSC', shortHi: 'CGPSC', mockSize: 25, hasMains: true },
  { id: 'si', nameEn: 'Police Sub-Inspector (SI)', nameHi: 'पुलिस उप निरीक्षक (SI)', shortEn: 'SI', shortHi: 'SI', mockSize: 25 },
  { id: 'patwari', nameEn: 'Patwari', nameHi: 'पटवारी', shortEn: 'Patwari', shortHi: 'पटवारी', mockSize: 25 },
  { id: 'mandi', nameEn: 'Mandi Inspector', nameHi: 'मंडी निरीक्षक', shortEn: 'Mandi', shortHi: 'मंडी', mockSize: 25 },
  { id: 'food', nameEn: 'Food Inspector', nameHi: 'खाद्य निरीक्षक', shortEn: 'Food', shortHi: 'खाद्य', mockSize: 25 },
  { id: 'other', nameEn: 'Other Exams', nameHi: 'अन्य परीक्षाएँ', shortEn: 'Other', shortHi: 'अन्य', mockSize: 25 },
];

const subjects = [
  { code: 'CGGK', nameEn: 'Chhattisgarh GK', nameHi: 'छत्तीसगढ़ सामान्य ज्ञान', topics: [['CG_HIST', 'CG History', 'छत्तीसगढ़ का इतिहास'], ['CG_GEO', 'CG Geography', 'छत्तीसगढ़ का भूगोल']] },
  { code: 'POL', nameEn: 'Polity', nameHi: 'राजव्यवस्था', topics: [['POLITY', 'Indian Constitution & Polity', 'भारतीय संविधान एवं राजव्यवस्था']] },
  { code: 'HIST', nameEn: 'History', nameHi: 'इतिहास', topics: [['HIST_MOD', 'Modern India', 'आधुनिक भारत']] },
  { code: 'GEO', nameEn: 'Geography', nameHi: 'भूगोल', topics: [['GEO_IND', 'Indian Geography', 'भारत का भूगोल']] },
  { code: 'CULT', nameEn: 'Culture', nameHi: 'संस्कृति', topics: [['CG_CULT', 'CG Culture', 'छत्तीसगढ़ की संस्कृति']] },
] as const;

type Q = [id: string, topic: string, ans: number, en: [string, string[], string], hi: [string, string[], string]];
const questions: Q[] = [
  ['SAMPLE-CGH-01', 'CG_HIST', 0, ['Chhattisgarh became a separate state on:', ['1 November 2000', '15 August 1947', '26 January 1950', '2 October 2000'], 'Chhattisgarh was carved out of Madhya Pradesh on 1 November 2000.'], ['छत्तीसगढ़ अलग राज्य कब बना?', ['1 नवंबर 2000', '15 अगस्त 1947', '26 जनवरी 1950', '2 अक्टूबर 2000'], 'छत्तीसगढ़ 1 नवंबर 2000 को मध्य प्रदेश से अलग होकर बना।']],
  ['SAMPLE-CGG-01', 'CG_GEO', 1, ['The principal river of Chhattisgarh is:', ['Narmada', 'Mahanadi', 'Godavari', 'Son'], 'The Mahanadi rises near Sihawa in Dhamtari district and drains most of the state.'], ['छत्तीसगढ़ की प्रमुख नदी कौन-सी है?', ['नर्मदा', 'महानदी', 'गोदावरी', 'सोन'], 'महानदी धमतरी जिले के सिहावा के निकट से निकलती है और राज्य के अधिकांश भाग को सींचती है।']],
  ['SAMPLE-CGG-02', 'CG_GEO', 2, ['Which state lies to the east of Chhattisgarh?', ['Maharashtra', 'Telangana', 'Odisha', 'Rajasthan'], 'Odisha borders Chhattisgarh on the east.'], ['छत्तीसगढ़ के पूर्व में कौन-सा राज्य स्थित है?', ['महाराष्ट्र', 'तेलंगाना', 'ओडिशा', 'राजस्थान'], 'ओडिशा छत्तीसगढ़ की पूर्वी सीमा पर स्थित है।']],
  ['SAMPLE-CGC-01', 'CG_CULT', 3, ['The state animal of Chhattisgarh is:', ['Tiger', 'Elephant', 'Barasingha', 'Wild buffalo (Van Bhainsa)'], 'The wild buffalo is the state animal.'], ['छत्तीसगढ़ का राजकीय पशु कौन-सा है?', ['बाघ', 'हाथी', 'बारहसिंगा', 'वन भैंसा'], 'वन भैंसा राज्य पशु है।']],
  ['SAMPLE-CGC-02', 'CG_CULT', 1, ['The state bird of Chhattisgarh is:', ['Peacock', 'Hill myna (Pahadi Maina)', 'Sparrow', 'Parrot'], 'The hill myna is the state bird.'], ['छत्तीसगढ़ का राजकीय पक्षी कौन-सा है?', ['मोर', 'पहाड़ी मैना', 'गौरैया', 'तोता'], 'पहाड़ी मैना राज्य पक्षी है।']],
  ['SAMPLE-POL-01', 'POLITY', 2, ['Fundamental Rights are contained in which Part of the Constitution?', ['Part I', 'Part II', 'Part III', 'Part IV'], 'Part III (Articles 12-35) contains the Fundamental Rights.'], ['मौलिक अधिकार संविधान के किस भाग में हैं?', ['भाग I', 'भाग II', 'भाग III', 'भाग IV'], 'भाग III (अनुच्छेद 12-35) में मौलिक अधिकार हैं।']],
  ['SAMPLE-POL-02', 'POLITY', 0, ['Article 21 of the Constitution protects:', ['Life and personal liberty', 'Freedom of speech', 'Right to equality', 'Right to property'], 'Article 21: protection of life and personal liberty.'], ['संविधान का अनुच्छेद 21 किसकी रक्षा करता है?', ['प्राण एवं दैहिक स्वतंत्रता', 'वाक् स्वतंत्रता', 'समता का अधिकार', 'संपत्ति का अधिकार'], 'अनुच्छेद 21: प्राण एवं दैहिक स्वतंत्रता का संरक्षण।']],
  ['SAMPLE-HIS-01', 'HIST_MOD', 1, ['The Dandi March was undertaken in the year:', ['1920', '1930', '1942', '1919'], 'Gandhi began the Salt March on 12 March 1930.'], ['दांडी मार्च किस वर्ष हुआ?', ['1920', '1930', '1942', '1919'], 'गांधीजी ने 12 मार्च 1930 को नमक यात्रा शुरू की।']],
  ['SAMPLE-GEO-01', 'GEO_IND', 0, ['India\'s national animal is:', ['Tiger', 'Lion', 'Elephant', 'Leopard'], 'The Bengal tiger is the national animal.'], ['भारत का राष्ट्रीय पशु कौन-सा है?', ['बाघ', 'सिंह', 'हाथी', 'तेंदुआ'], 'बंगाल टाइगर राष्ट्रीय पशु है।']],
  ['SAMPLE-CGC-03', 'CG_CULT', 0, ['Panthi is a folk dance associated with which community?', ['Satnami', 'Gond', 'Baiga', 'Halba'], 'Panthi is performed by the Satnami community.'], ['पंथी नृत्य किस समुदाय से संबंधित है?', ['सतनामी', 'गोंड', 'बैगा', 'हल्बा'], 'पंथी नृत्य सतनामी समुदाय द्वारा किया जाता है।']],
];

async function main() {
  for (const [i, e] of exams.entries()) {
    await prisma.exam.upsert({ where: { id: e.id }, update: {}, create: { ...e, sort: i } });
  }
  for (const [i, s] of subjects.entries()) {
    await prisma.subject.upsert({ where: { code: s.code }, update: {}, create: { code: s.code, nameEn: s.nameEn, nameHi: s.nameHi, sort: i } });
    for (const [j, [code, en, hi]] of s.topics.entries()) {
      await prisma.topic.upsert({ where: { code }, update: {}, create: { code, subjectCode: s.code, nameEn: en, nameHi: hi, sort: j } });
    }
  }
  for (const [id, topic, ans, en, hi] of questions) {
    await prisma.question.upsert({
      where: { id },
      update: {},
      create: {
        id,
        topicCode: topic,
        answer: ans,
        published: true,
        body: { en: { q: en[0], o: en[1], s: en[2] }, hi: { q: hi[0], o: hi[1], s: hi[2] } },
      },
    });
  }
  const sampleIds = questions.map((q) => q[0]);
  await prisma.test.upsert({
    where: { id: 'cgpsc_sample_free' },
    update: {},
    create: {
      id: 'cgpsc_sample_free',
      examId: 'cgpsc',
      title: { en: 'Sample diagnostic test', hi: 'नमूना डायग्नोस्टिक टेस्ट' },
      kind: TestKind.diagnostic,
      access: AccessLevel.free,
      durationMin: 15,
      published: true,
      questions: { create: sampleIds.map((questionId, position) => ({ questionId, position })) },
    },
  });
  await prisma.test.upsert({
    where: { id: 'cgpsc_sample_paid' },
    update: {},
    create: {
      id: 'cgpsc_sample_paid',
      examId: 'cgpsc',
      title: { en: 'Sample paid mock', hi: 'नमूना पेड मॉक' },
      kind: TestKind.mock,
      access: AccessLevel.paid,
      durationMin: 15,
      published: true,
      questions: { create: sampleIds.slice(0, 5).map((questionId, position) => ({ questionId, position })) },
    },
  });
  await prisma.plan.upsert({
    where: { id: 'pass_prelims' },
    update: {},
    create: { id: 'pass_prelims', nameEn: 'Prelims Pass', nameHi: 'प्रारंभिक पास', prices: { '3': 399, '6': 699, '12': 999 }, trialDays: 7 },
  });
  await prisma.plan.upsert({
    where: { id: 'pass_full' },
    update: {},
    create: {
      id: 'pass_full',
      nameEn: 'Prelims + Mains Pass',
      nameHi: 'प्रारंभिक + मुख्य पास',
      prices: { '3': 599, '6': 999, '12': 1499 },
      trialDays: 7,
      topTier: true,
      exams: { create: [{ examId: 'cgpsc' }] },
    },
  });
  console.log('seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
