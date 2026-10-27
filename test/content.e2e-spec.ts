import { INestApplication } from '@nestjs/common';
import { AccessLevel } from '@prisma/client';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createApp, login, resetDb } from './helpers';

describe('content', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => ({ app, prisma } = await createApp()));
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.exam.create({ data: { id: 'cgpsc', nameEn: 'C', nameHi: 'C', shortEn: 'C', shortHi: 'C' } });
    await prisma.subject.create({ data: { code: 'HIST', nameEn: 'History', nameHi: 'इतिहास' } });
    await prisma.note.create({ data: { id: 'free_note', subjectCode: 'HIST', titleEn: 'A', titleHi: 'क', access: AccessLevel.free, sections: [], published: true } });
    await prisma.note.create({ data: { id: 'paid_note', subjectCode: 'HIST', titleEn: 'B', titleHi: 'ख', access: AccessLevel.paid, sections: [], published: true } });
    await prisma.note.create({ data: { id: 'draft_note', subjectCode: 'HIST', titleEn: 'C', titleHi: 'ग', sections: [], published: false } });
  });

  it('serves exams, subjects and server time without login', async () => {
    expect((await http().get('/v1/exams').expect(200)).body).toHaveLength(1);
    expect((await http().get('/v1/subjects').expect(200)).body[0].code).toBe('HIST');
    const t = await http().get('/v1/time').expect(200);
    expect(Math.abs(new Date(t.body.serverTime).getTime() - Date.now())).toBeLessThan(5000);
  });

  it('lists published notes with a locked flag and hides drafts', async () => {
    const s = await login(app, 'n1');
    const res = await http().get('/v1/notes').set(bearer(s.body.accessToken)).expect(200);
    const ids = res.body.map((n: { id: string }) => n.id).sort();
    expect(ids).toEqual(['free_note', 'paid_note']);
    expect(res.body.find((n: { id: string }) => n.id === 'paid_note').locked).toBe(true);
    await http().get('/v1/notes/draft_note').set(bearer(s.body.accessToken)).expect(404);
  });

  it('denies paid note content without a paid plan', async () => {
    const s = await login(app, 'n2');
    const h = bearer(s.body.accessToken);
    await http().get('/v1/notes/free_note').set(h).expect(200);
    const res = await http().get('/v1/notes/paid_note').set(h).expect(403);
    expect(res.body.error.code).toBe('PAYMENT_REQUIRED');
    await http().get('/v1/notes').expect(401);
  });
});
