import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { bearer, createApp, login, resetDb, TestApp } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ev = Record<string, any>;

/** Whole battles in about a second: the round clock and the waiting time are shortened through the environment. */
describe('1-v-1 battle (sockets)', () => {
  let t: TestApp;
  let url = '';
  const sockets: Socket[] = [];
  const saved: Record<string, string | undefined> = {};
  const env = { BATTLE_QUESTIONS: '3', BATTLE_ROUND_MS: '700', BATTLE_COUNTDOWN_MS: '40', BATTLE_REVEAL_MS: '40', BATTLE_BOT_AFTER_MS: '900', BATTLE_FREE_LIMIT: '2' };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    t = await createApp();
    await (t.app as INestApplication).listen(0, '127.0.0.1');
    url = (await t.app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await t.app.close();
  });
  beforeEach(async () => {
    await resetDb(t.prisma);
    await t.prisma.subject.create({ data: { code: 'GK', nameEn: 'GK', nameHi: 'सामान्य ज्ञान' } });
    await t.prisma.topic.create({ data: { code: 'GKT', subjectCode: 'GK', nameEn: 'GK', nameHi: 'GK' } });
    for (let i = 0; i < 6; i++) {
      await t.prisma.question.create({
        data: { type: 'single', topicCode: 'GKT', status: 'published', answer: i % 4, hasEn: true, contentHash: `h${i}`, body: { en: { stem: `Question ${i}?`, options: ['a', 'b', 'c', 'd'], explanation: `Because ${i}` } } },
      });
    }
  });

  async function player(sub: string) {
    const s = await login(t.app, sub, `device-${sub}-1`, 'android', `Player ${sub}`);
    const token = s.body.accessToken as string;
    const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await new Promise<void>((res, rej) => {
      socket.on('connect', () => res());
      socket.on('connect_error', rej);
    });
    return { token, socket, id: s.body.user.id as string };
  }
  const next = (s: Socket, ev: string, ms = 5000) => new Promise<Ev>((res, rej) => { const to = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms); s.once(ev, (d: Ev) => { clearTimeout(to); res(d); }); });
  const ack = (s: Socket, ev: string, body?: unknown) => new Promise<Ev>((res) => s.emit(ev, body, res));
  const correctOf = async (battleId: string, index: number) => {
    const b = await t.prisma.battle.findUniqueOrThrow({ where: { id: battleId } });
    return (await t.prisma.question.findUniqueOrThrow({ where: { id: b.questionIds[index] } })).answer;
  };

  it('rejects a socket without a valid token', async () => {
    const s = io(url, { auth: { token: 'nope' }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    const err = await next(s, 'battle:error');
    expect(err.code).toBe('UNAUTHENTICATED');
  });

  it('two students play a full battle: server-scored, answers hidden until the reveal, winner gets points', async () => {
    const a = await player('a');
    const b = await player('b');
    const matchedA = next(a.socket, 'battle:matched');
    const matchedB = next(b.socket, 'battle:matched');
    expect((await ack(a.socket, 'battle:find')).ok).toBe(true);
    expect((await ack(b.socket, 'battle:find')).ok).toBe(true);
    const [ma, mb] = await Promise.all([matchedA, matchedB]);
    expect(ma.battleId).toBe(mb.battleId);
    expect(ma.opponent.isBot).toBe(false);
    expect(ma.total).toBe(3);

    const end = Promise.all([next(a.socket, 'battle:end', 8000), next(b.socket, 'battle:end', 8000)]);
    for (let i = 0; i < 3; i++) {
      const [qa] = await Promise.all([next(a.socket, 'battle:question'), next(b.socket, 'battle:question')]);
      // the question never carries the answer or the explanation
      expect(JSON.stringify(qa)).not.toMatch(/explanation|Because/);
      expect(qa.question.en.options).toHaveLength(4);
      const right = await correctOf(ma.battleId, i);
      const revealA = next(a.socket, 'battle:reveal');
      expect((await ack(a.socket, 'battle:answer', { battleId: ma.battleId, index: i, option: right })).ok).toBe(true);
      // a second answer to the same question is refused
      expect((await ack(a.socket, 'battle:answer', { battleId: ma.battleId, index: i, option: right })).code).toBe('ALREADY_ANSWERED');
      expect((await ack(b.socket, 'battle:answer', { battleId: ma.battleId, index: i, option: (right + 1) % 4 })).ok).toBe(true);
      const rv = await revealA;
      expect(rv.correctOption).toBe(right);
      expect(rv.you.correct).toBe(true);
      expect(rv.opponent.correct).toBe(false);
    }
    const [endA, endB] = await end;
    expect(endA.result).toBe('win');
    expect(endB.result).toBe('loss');
    expect(endA.you.pointsDelta).toBe(25);
    expect(endB.you.pointsDelta).toBe(0);
    expect(endA.you.score).toBeGreaterThan(endB.you.score);

    const meA = (await request(t.app.getHttpServer()).get('/v1/battle/me').set(bearer(a.token)).expect(200)).body;
    expect(meA).toMatchObject({ points: 25, played: 1, wins: 1, freeLeft: 1 });
    const lb = (await request(t.app.getHttpServer()).get('/v1/battle/leaderboard').set(bearer(b.token)).expect(200)).body;
    expect(lb.entries[0]).toMatchObject({ points: 25, rank: 1 });
    expect(lb.me).toMatchObject({ points: 0 });
    // points from a battle against a real student also appear in the overall leaderboard
    const overall = (await request(t.app.getHttpServer()).get('/v1/leaderboard?period=week').set(bearer(a.token)).expect(200)).body;
    expect(overall.entries[0]).toMatchObject({ rank: 1, score: 25, isMe: true });
  });

  it('a lone student is paired with a labelled practice partner after the wait', async () => {
    const a = await player('solo');
    const matched = next(a.socket, 'battle:matched', 4000);
    await ack(a.socket, 'battle:find');
    const m = await matched;
    expect(m.opponent.isBot).toBe(true);
    expect(typeof m.opponent.name).toBe('string');
    const end = next(a.socket, 'battle:end', 8000);
    for (let i = 0; i < 3; i++) {
      await next(a.socket, 'battle:question');
      await ack(a.socket, 'battle:answer', { battleId: m.battleId, index: i, option: await correctOf(m.battleId, i) });
    }
    const e = await end;
    expect(e.opponent.isBot).toBe(true);
    expect(e.you.pointsDelta).toBeLessThanOrEqual(15);
    const rows = await t.prisma.battlePlayer.findMany({ where: { battleId: m.battleId } });
    expect(rows.filter((r) => r.isBot)).toHaveLength(1);
    expect(rows.find((r) => r.isBot)!.userId).toBeNull();
  });

  it('free students can play only the free limit, then see BATTLE_LIMIT; a paid plan lifts it', async () => {
    const a = await player('limit');
    const playOne = async () => {
      const matched = next(a.socket, 'battle:matched', 4000);
      const r = await ack(a.socket, 'battle:find');
      if (!r.ok) return r;
      const m = await matched;
      await next(a.socket, 'battle:end', 9000);
      return { ok: true, battleId: m.battleId };
    };
    expect((await playOne()).ok).toBe(true);
    expect((await playOne()).ok).toBe(true);
    const blocked = await ack(a.socket, 'battle:find');
    expect(blocked).toMatchObject({ ok: false, code: 'BATTLE_LIMIT', details: { used: 2, limit: 2 } });
    const me = (await request(t.app.getHttpServer()).get('/v1/battle/me').set(bearer(a.token)).expect(200)).body;
    expect(me).toMatchObject({ canPlay: false, freeLeft: 0 });

    await t.prisma.plan.create({ data: { id: 'pro', nameEn: 'Pro', nameHi: 'Pro', prices: { '3': 399 } } });
    await t.prisma.entitlement.create({ data: { userId: a.id, planId: 'pro', endsAt: new Date(Date.now() + 86_400_000), source: 'payment' } });
    expect((await playOne()).ok).toBe(true);
  });

  it('a student who reconnects mid-battle is put back where the battle is', async () => {
    const a = await player('re');
    const matched = next(a.socket, 'battle:matched', 4000);
    await ack(a.socket, 'battle:find');
    const m = await matched;
    await next(a.socket, 'battle:question');
    a.socket.close();
    const again = io(url, { auth: { token: a.token }, transports: ['websocket'], reconnection: false });
    sockets.push(again);
    const resumed = await next(again, 'battle:resumed', 4000);
    expect(resumed.battleId).toBe(m.battleId);
    expect(resumed.opponent.isBot).toBe(true);
  });
});
