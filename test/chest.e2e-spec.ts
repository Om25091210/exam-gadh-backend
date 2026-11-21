import request from 'supertest';
import { bearer, createApp, login, resetDb, TestApp } from './helpers';

describe('daily bonus chest', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createApp()));
  afterAll(() => t.app.close());
  beforeEach(() => resetDb(t.prisma));
  const http = () => request(t.app.getHttpServer());

  async function student(sub: string) {
    const s = await login(t.app, sub);
    return { h: bearer(s.body.accessToken), id: s.body.user.id as string };
  }
  /** a finished battle today is enough to unlock the chest */
  const playedToday = async (userId: string) => {
    const b = await t.prisma.battle.create({ data: { mode: 'human', questionIds: [], roundMs: 1000, status: 'finished', finishedAt: t.clock.now() } });
    await t.prisma.battlePlayer.create({ data: { battleId: b.id, userId, displayName: 'X', result: 'win' } });
  };

  it('is locked until the student has practised today, and nothing is granted', async () => {
    const a = await student('a');
    expect((await http().get('/v1/me/chest').set(a.h).expect(200)).body).toMatchObject({ eligible: false, opened: false, available: false });
    expect((await http().post('/v1/me/chest/open').set(a.h).expect(409)).body.error.code).toBe('CHEST_LOCKED');
    expect(await t.prisma.dailyChest.count()).toBe(0);
  });

  it('opens once a day with a server-rolled reward that is added to battle points', async () => {
    const a = await student('b');
    await playedToday(a.id);
    expect((await http().get('/v1/me/chest').set(a.h).expect(200)).body).toMatchObject({ available: true });
    const r = (await http().post('/v1/me/chest/open').set(a.h).expect(200)).body;
    expect([5, 10, 25]).toContain(r.points);
    expect((await http().post('/v1/me/chest/open').set(a.h).expect(409)).body.error.code).toBe('CHEST_ALREADY_OPENED');
    expect((await http().get('/v1/me/chest').set(a.h).expect(200)).body).toMatchObject({ opened: true, points: r.points, available: false });
    expect((await http().get('/v1/battle/me').set(a.h).expect(200)).body.points).toBe(r.points);
  });

  it('comes back the next India day', async () => {
    const a = await student('c');
    await playedToday(a.id);
    await http().post('/v1/me/chest/open').set(a.h).expect(200);
    t.clock.advance(26 * 3_600_000);
    await playedToday(a.id);
    expect((await http().get('/v1/me/chest').set(a.h).expect(200)).body).toMatchObject({ available: true, opened: false });
  });

  it('requires sign-in', async () => {
    await http().get('/v1/me/chest').expect(401);
  });
});
