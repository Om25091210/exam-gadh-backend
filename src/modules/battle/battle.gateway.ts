import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { SessionService } from '../../auth/session.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BattleEngine, BattleError } from './battle.engine';

type Ack = { ok: true; [k: string]: unknown } | { ok: false; code: string; message: string; details?: Record<string, unknown> };

/**
 * Socket.IO endpoint for 1-v-1 battles. A phone connects with its normal access token:
 *   io(API_URL, { path: '/socket.io', auth: { token } })
 * and then uses the battle:* events below. Every handler answers with { ok } so the app knows what happened.
 */
@WebSocketGateway({ transports: ['websocket', 'polling'], pingInterval: 10_000, pingTimeout: 8_000, maxHttpBufferSize: 10_000 })
export class BattleGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger('BattleGateway');

  constructor(
    private readonly engine: BattleEngine,
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(server: Server) {
    this.engine.attach(server);
  }

  /** Checks the token. Stored as a promise so a phone that sends its first message the instant it connects simply waits for it. */
  handleConnection(client: Socket) {
    client.data.ready = this.authenticate(client);
  }

  private async authenticate(client: Socket): Promise<{ id: string; name: string } | null> {
    try {
      const token = typeof client.handshake.auth?.token === 'string' ? client.handshake.auth.token : '';
      if (!token) throw new BattleError('UNAUTHENTICATED', 'Sign in first');
      const payload = await this.jwt.verifyAsync<{ sub: string; sid: string }>(token, { algorithms: ['HS256'], issuer: 'examgadh' });
      await this.sessions.assertActive(payload.sid, payload.sub);
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, name: true } });
      if (!user) throw new BattleError('UNAUTHENTICATED', 'Sign in first');
      client.data.user = { id: user.id, name: user.name };
      // a student who is already mid-battle (app restarted, network dropped) is put straight back in
      this.engine.resume(user.id, client.id);
      return client.data.user as { id: string; name: string };
    } catch (e) {
      const expired = e instanceof Error && e.name === 'TokenExpiredError';
      client.emit('battle:error', { code: expired ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED', message: 'Please sign in again' });
      client.disconnect(true);
      return null;
    }
  }

  /** The signed-in student of this socket, once the token check has finished. */
  private async who(client: Socket): Promise<{ id: string; name: string }> {
    const u = (await (client.data.ready as Promise<{ id: string; name: string } | null> | undefined)) ?? null;
    if (!u) throw new BattleError('UNAUTHENTICATED', 'Sign in first');
    return u;
  }

  handleDisconnect(client: Socket) {
    this.engine.disconnect(client.id);
  }

  private async run(fn: () => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<Ack> {
    try {
      return { ok: true, ...(await fn()) };
    } catch (e) {
      if (e instanceof BattleError) return { ok: false, code: e.code, message: e.message, details: e.details };
      this.log.error((e as Error).message);
      return { ok: false, code: 'BATTLE_FAILED', message: 'Something went wrong' };
    }
  }

  @SubscribeMessage('battle:find')
  find(@ConnectedSocket() client: Socket, @MessageBody() body: { topicCode?: string } | undefined): Promise<Ack> {
    return this.run(async () => {
      const u = await this.who(client);
      const topic = typeof body?.topicCode === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(body.topicCode) ? body.topicCode : null;
      return { ...(await this.engine.find(u.id, u.name, client.id, topic)) };
    });
  }

  @SubscribeMessage('battle:cancel')
  cancel(@ConnectedSocket() client: Socket): Promise<Ack> {
    return this.run(async () => ({ cancelled: this.engine.cancel((await this.who(client)).id) }));
  }

  @SubscribeMessage('battle:answer')
  answer(@ConnectedSocket() client: Socket, @MessageBody() body: { battleId?: string; index?: number; option?: number } | undefined): Promise<Ack> {
    return this.run(async () => {
      const u = await this.who(client);
      if (typeof body?.battleId !== 'string' || typeof body.index !== 'number' || typeof body.option !== 'number') throw new BattleError('INVALID_REQUEST', 'battleId, index and option are required');
      this.engine.answer(u.id, body.battleId, body.index, body.option);
      return {};
    });
  }

  /** Ask where the student's battle stands (the answer also arrives as battle:resumed). */
  @SubscribeMessage('battle:state')
  state(@ConnectedSocket() client: Socket): Promise<Ack> {
    return this.run(async () => ({ inBattle: this.engine.resume((await this.who(client)).id, client.id) }));
  }
}
