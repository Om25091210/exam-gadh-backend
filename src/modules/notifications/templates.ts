export type NotificationKind = 'result_ready' | 'live_test' | 'doubt_answered' | 'announcement' | 'plan_expiring' | 'study_plan_ready';

interface Template {
  titleEn: string;
  titleHi: string;
  bodyEn: string;
  bodyHi: string;
  /** Reminders count against the student's daily nudge cap; answers to their own actions do not. */
  nudge: boolean;
}

/** Built-in wording. An admin can override any of these by creating a NotificationTemplate with the same key. */
export const DEFAULT_TEMPLATES: Record<NotificationKind, Template> = {
  result_ready: { nudge: false, titleEn: 'Your result is ready', titleHi: 'आपका परिणाम तैयार है', bodyEn: '{{title}}: see your score, rank and solutions.', bodyHi: '{{title}}: अपना स्कोर, रैंक और हल देखें।' },
  live_test: { nudge: true, titleEn: 'Live test starting soon', titleHi: 'लाइव टेस्ट जल्द शुरू होगा', bodyEn: '{{title}} starts at {{time}}. Be ready a few minutes early.', bodyHi: '{{title}} {{time}} पर शुरू होगा। कुछ मिनट पहले तैयार रहें।' },
  doubt_answered: { nudge: false, titleEn: 'Your doubt has been answered', titleHi: 'आपके संदेह का उत्तर आ गया है', bodyEn: 'A teacher replied to your doubt. Open it to read the answer.', bodyHi: 'शिक्षक ने आपके संदेह का उत्तर दिया है। पढ़ने के लिए खोलें।' },
  announcement: { nudge: true, titleEn: '{{title}}', titleHi: '{{title}}', bodyEn: '{{body}}', bodyHi: '{{body}}' },
  plan_expiring: { nudge: true, titleEn: 'Your plan ends soon', titleHi: 'आपका प्लान जल्द समाप्त होगा', bodyEn: 'Your {{plan}} plan ends on {{date}}. Renew to keep access to paid tests and notes.', bodyHi: 'आपका {{plan}} प्लान {{date}} को समाप्त होगा। पेड टेस्ट और नोट्स की पहुँच बनाए रखने के लिए नवीनीकरण करें।' },
  study_plan_ready: { nudge: false, titleEn: 'Your study plan is ready', titleHi: 'आपकी अध्ययन योजना तैयार है', bodyEn: 'Your mentor has sent your plan up to {{date}}. Open Planner to see it.', bodyHi: 'आपके मेंटर ने {{date}} तक की योजना भेजी है। देखने के लिए प्लानर खोलें।' },
};

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Plain-text substitution only: values are never interpreted as markup, and unknown placeholders become empty. */
export function render(text: string, vars: Record<string, string | number>): string {
  return text.replace(PLACEHOLDER, (_, k: string) => String(vars[k] ?? '')).slice(0, 500);
}
