import request from 'supertest';
import { bearer, createApp, login, resetDb, TestApp } from './helpers';

describe('student notes: read and like', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createApp()));
  afterAll(() => t.app.close());
  beforeEach(async () => {
    await resetDb(t.prisma);
    await t.prisma.subject.create({ data: { code: 'POL', nameEn: 'Polity', nameHi: 'राजव्यवस्था' } });
    const sections = [{ anchor: 'intro', en: { title: 'Intro', blocks: [{ t: 'p', x: 'The Constitution is the supreme law.' }] }, hi: { title: 'परिचय', blocks: [{ t: 'p', x: 'संविधान सर्वोच्च विधि है।' }] } }];
    await t.prisma.note.create({ data: { id: 'polity-basics', subjectCode: 'POL', titleEn: 'Polity basics', titleHi: 'राजव्यवस्था की मूल बातें', sections, published: true } });
    await t.prisma.note.create({ data: { id: 'draft-note', subjectCode: 'POL', titleEn: 'Draft', titleHi: 'मसौदा', sections, published: false } });
    await t.prisma.note.create({ data: { id: 'paid-note', subjectCode: 'POL', titleEn: 'Paid', titleHi: 'सशुल्क', access: 'paid', sections, published: true } });
  });
  const http = () => request(t.app.getHttpServer());
  const auth = async (sub: string) => bearer((await login(t.app, sub)).body.accessToken);

  it('lists only published notes; a paid note is marked locked and its body is refused', async () => {
    const h = await auth('a');
    const list = (await http().get('/v1/notes').set(h).expect(200)).body as Array<{ id: string; locked: boolean; likes: number; liked: boolean; sectionCount: number; readMinutes: number; sections?: unknown }>;
    expect(list.map((n) => n.id).sort()).toEqual(['paid-note', 'polity-basics']);
    expect(list.find((n) => n.id === 'paid-note')!.locked).toBe(true);
    expect(list[0].sections).toBeUndefined();
    expect(list.find((n) => n.id === 'polity-basics')).toMatchObject({ sectionCount: 1, readMinutes: 1, likes: 0, liked: false });
    const free = (await http().get('/v1/notes/polity-basics').set(h).expect(200)).body;
    expect(free.sections).toHaveLength(1);
    expect((await http().get('/v1/notes/paid-note').set(h).expect(403)).body.error.code).toBe('PAYMENT_REQUIRED');
    await http().get('/v1/notes/draft-note').set(h).expect(404);
  });

  it('likes are per student, idempotent, and counted', async () => {
    const a = await auth('a');
    const b = await auth('b');
    expect((await http().put('/v1/notes/polity-basics/like').set(a).expect(200)).body).toEqual({ liked: true, likes: 1 });
    expect((await http().put('/v1/notes/polity-basics/like').set(a).expect(200)).body).toEqual({ liked: true, likes: 1 });
    expect((await http().put('/v1/notes/polity-basics/like').set(b).expect(200)).body.likes).toBe(2);
    const detail = (await http().get('/v1/notes/polity-basics').set(a).expect(200)).body;
    expect(detail).toMatchObject({ liked: true, likes: 2 });
    expect((await http().delete('/v1/notes/polity-basics/like').set(a).expect(200)).body).toEqual({ liked: false, likes: 1 });
    const mine = (await http().get('/v1/notes').set(a).expect(200)).body.find((n: { id: string }) => n.id === 'polity-basics');
    expect(mine).toMatchObject({ liked: false, likes: 1 });
    await http().put('/v1/notes/draft-note/like').set(a).expect(404);
  });

  it('requires sign-in', async () => {
    await http().get('/v1/notes').expect(401);
  });
});
