import request from 'supertest';
import { bearer, createApp, login, resetDb, rzpSignature, TestApp } from './helpers';

/** Placeholder credentials ('unset') must switch payments off completely: a signature made with a known key proves nothing. */
describe('billing with placeholder Razorpay credentials', () => {
  let t: TestApp;
  const saved = { s: process.env.RAZORPAY_KEY_SECRET, w: process.env.RAZORPAY_WEBHOOK_SECRET };
  beforeAll(async () => {
    process.env.RAZORPAY_KEY_SECRET = 'unset';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'unset';
    t = await createApp();
  });
  afterAll(async () => {
    process.env.RAZORPAY_KEY_SECRET = saved.s;
    process.env.RAZORPAY_WEBHOOK_SECRET = saved.w;
    await t.app.close();
  });
  beforeEach(async () => {
    await resetDb(t.prisma);
    await t.prisma.plan.create({ data: { id: 'pass_prelims', nameEn: 'P', nameHi: 'P', prices: { '3': 399 } } });
  });
  const http = () => request(t.app.getHttpServer());

  it('refuses to create orders', async () => {
    const s = await login(t.app, 'buyer');
    const res = await http().post('/v1/billing/orders').set(bearer(s.body.accessToken)).send({ planId: 'pass_prelims', months: 3 }).expect(503);
    expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
  });

  it('does not accept a payment signature forged with the placeholder key', async () => {
    const s = await login(t.app, 'buyer');
    const user = await t.prisma.user.findFirstOrThrow();
    const order = await t.prisma.order.create({ data: { userId: user.id, planId: 'pass_prelims', months: 3, amountPaise: 39_900, razorpayOrderId: 'order_forge_1' } });
    const res = await http()
      .post('/v1/billing/verify')
      .set(bearer(s.body.accessToken))
      .send({ razorpay_order_id: 'order_forge_1', razorpay_payment_id: 'pay_forged', razorpay_signature: rzpSignature('unset', 'order_forge_1|pay_forged') })
      .expect(503);
    expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
    expect(await t.prisma.entitlement.count()).toBe(0);
    expect((await t.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).not.toBe('paid');
  });

  it('does not accept a webhook signed with the placeholder secret', async () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_forge_1', amount: 39_900 } } } });
    const res = await http().post('/v1/billing/webhook').set('x-razorpay-signature', rzpSignature('unset', body)).set('Content-Type', 'application/json').send(body).expect(503);
    expect(res.body.error.code).toBe('WEBHOOK_UNAVAILABLE');
  });
});
