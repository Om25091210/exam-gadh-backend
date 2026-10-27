import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from './helpers';

describe('rate limiting', () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.THROTTLE_DISABLED = '0';
    ({ app } = await createApp());
  });
  afterAll(async () => {
    process.env.THROTTLE_DISABLED = '1';
    await app.close();
  });

  it('limits login attempts per IP and answers with the standard error shape', async () => {
    const body = { idToken: 'forged', deviceId: 'device-12345', platform: 'android' };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await request(app.getHttpServer()).post('/v1/auth/google').send(body)).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    const res = await request(app.getHttpServer()).post('/v1/auth/google').send(body).expect(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});
