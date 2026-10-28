import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { SessionService } from '../src/auth/session.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createApp, login, resetDb } from './helpers';
import { SessionRevokeReason } from '@prisma/client';

describe('student suspension', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => ({ app, prisma } = await createApp()));
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));
  const http = () => request(app.getHttpServer());

  it('takes effect on the very next request (no waiting for the session cache) and blocks sign-in until reactivated', async () => {
    const s = await login(app, 'stu');
    const h = bearer(s.body.accessToken);
    await http().get('/v1/me').set(h).expect(200); // warms the session cache

    await prisma.user.update({ where: { id: s.body.user.id }, data: { status: 'suspended', suspendedAt: new Date(), suspendReason: 'test' } });
    await app.get(SessionService).revokeAllForUser(s.body.user.id, SessionRevokeReason.SUSPENDED);

    const next = await http().get('/v1/me').set(h).expect(401);
    expect(next.body.error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await login(app, 'stu')).status).toBe(403);
    expect((await login(app, 'stu')).body.error.code).toBe('ACCOUNT_SUSPENDED');

    await prisma.user.update({ where: { id: s.body.user.id }, data: { status: 'active', suspendedAt: null, suspendReason: null } });
    const again = await login(app, 'stu');
    expect(again.status).toBe(200);
    await http().get('/v1/me').set(bearer(again.body.accessToken)).expect(200);
  });

  it('is enforced even without a session revoke: a suspended user fails the check on cache miss', async () => {
    const s = await login(app, 'stu2');
    await prisma.user.update({ where: { id: s.body.user.id }, data: { status: 'suspended' } });
    app.get(SessionService)['cache'].clear();
    expect((await http().get('/v1/me').set(bearer(s.body.accessToken)).expect(401)).body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});
