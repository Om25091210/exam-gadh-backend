import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { bearer, createApp, login, resetDb, rzpSignature } from './helpers';

const KEY_SECRET = 'rzp_test_secret_value';
const WEBHOOK_SECRET = 'whsec_test_value';

describe('billing (Razorpay)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => ({ app, prisma } = await createApp()));
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer());

  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.plan.create({ data: { id: 'pass_prelims', nameEn: 'P', nameHi: 'P', prices: { '3': 399, '6': 699, '12': 999 } } });
  });

  async function newOrder(sub = 'buyer', months = 3) {
    const s = await login(app, sub);
    const h = bearer(s.body.accessToken);
    const o = await http().post('/v1/billing/orders').set(h).send({ planId: 'pass_prelims', months }).expect(201);
    return { s, h, o: o.body as { orderId: string; razorpayOrderId: string; amountPaise: number; keyId: string } };
  }

  it('lists plans publicly', async () => {
    const res = await http().get('/v1/plans').expect(200);
    expect(res.body[0]).toMatchObject({ id: 'pass_prelims', prices: { '3': 399, '6': 699, '12': 999 } });
  });

  it('creates an order with the price from the server, not the client', async () => {
    const { o } = await newOrder('buyer', 6);
    expect(o.amountPaise).toBe(69_900);
    expect(o.keyId).toBe('rzp_test_key');
    expect(o.razorpayOrderId).toMatch(/^order_fake_/);
  });

  it('rejects invalid plan, duration and unauthenticated order creation', async () => {
    const s = await login(app, 'x');
    const h = bearer(s.body.accessToken);
    await http().post('/v1/billing/orders').set(h).send({ planId: 'nope', months: 3 }).expect(404);
    await http().post('/v1/billing/orders').set(h).send({ planId: 'pass_prelims', months: 5 }).expect(400);
    await http().post('/v1/billing/orders').send({ planId: 'pass_prelims', months: 3 }).expect(401);
  });

  it('verify rejects a wrong signature and grants nothing', async () => {
    const { h, o } = await newOrder();
    const res = await http()
      .post('/v1/billing/verify')
      .set(h)
      .send({ razorpay_order_id: o.razorpayOrderId, razorpay_payment_id: 'pay_1', razorpay_signature: 'deadbeef' })
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await prisma.entitlement.count()).toBe(0);
  });

  it('verify with a valid signature grants an entitlement exactly once', async () => {
    const { h, o } = await newOrder();
    const body = {
      razorpay_order_id: o.razorpayOrderId,
      razorpay_payment_id: 'pay_ok_1',
      razorpay_signature: rzpSignature(KEY_SECRET, `${o.razorpayOrderId}|pay_ok_1`),
    };
    const first = await http().post('/v1/billing/verify').set(h).send(body).expect(200);
    expect(first.body).toHaveLength(1);
    await http().post('/v1/billing/verify').set(h).send(body).expect(200);
    expect(await prisma.entitlement.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } });
    expect(order.status).toBe('paid');
    const ent = await prisma.entitlement.findFirstOrThrow();
    const days = (ent.endsAt.getTime() - ent.startsAt.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(88);
    expect(days).toBeLessThan(93);
  });

  it("another user cannot verify someone else's order", async () => {
    const { o } = await newOrder('owner');
    const thief = await login(app, 'thief');
    await http()
      .post('/v1/billing/verify')
      .set(bearer(thief.body.accessToken))
      .send({
        razorpay_order_id: o.razorpayOrderId,
        razorpay_payment_id: 'pay_x',
        razorpay_signature: rzpSignature(KEY_SECRET, `${o.razorpayOrderId}|pay_x`),
      })
      .expect(404);
  });

  const webhook = (payload: object, secret = WEBHOOK_SECRET, sig?: string) => {
    const raw = JSON.stringify(payload);
    return http()
      .post('/v1/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', sig ?? rzpSignature(secret, raw))
      .send(raw);
  };
  const captured = (orderId: string, paymentId: string, amount: number) => ({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, method: 'upi' } } },
  });

  it('webhook rejects a bad or missing signature', async () => {
    const { o } = await newOrder();
    await webhook(captured(o.razorpayOrderId, 'pay_w1', o.amountPaise), WEBHOOK_SECRET, 'bad').expect(400);
    await http().post('/v1/billing/webhook').set('Content-Type', 'application/json').send('{}').expect(400);
    expect(await prisma.entitlement.count()).toBe(0);
  });

  it('webhook grants the entitlement and is idempotent with verify', async () => {
    const { h, o } = await newOrder();
    await webhook(captured(o.razorpayOrderId, 'pay_w2', o.amountPaise)).expect(200);
    await webhook(captured(o.razorpayOrderId, 'pay_w2', o.amountPaise)).expect(200); // retry from Razorpay
    await http()
      .post('/v1/billing/verify')
      .set(h)
      .send({
        razorpay_order_id: o.razorpayOrderId,
        razorpay_payment_id: 'pay_w2',
        razorpay_signature: rzpSignature(KEY_SECRET, `${o.razorpayOrderId}|pay_w2`),
      })
      .expect(200);
    expect(await prisma.entitlement.count()).toBe(1);
    const me = await http().get('/v1/entitlements').set(h).expect(200);
    expect(me.body).toHaveLength(1);
  });

  it('webhook refuses a payment whose amount differs from the order', async () => {
    const { o } = await newOrder();
    const res = await webhook(captured(o.razorpayOrderId, 'pay_w3', 100)).expect(422);
    expect(res.body.error.code).toBe('AMOUNT_MISMATCH');
    expect(await prisma.entitlement.count()).toBe(0);
  });

  it('a second purchase extends from the end of the current entitlement', async () => {
    const { o } = await newOrder('renew', 3);
    await webhook(captured(o.razorpayOrderId, 'pay_r1', o.amountPaise)).expect(200);
    const s = await login(app, 'renew');
    const o2 = (await http().post('/v1/billing/orders').set(bearer(s.body.accessToken)).send({ planId: 'pass_prelims', months: 3 }).expect(201)).body;
    await webhook(captured(o2.razorpayOrderId, 'pay_r2', o2.amountPaise)).expect(200);
    const ents = await prisma.entitlement.findMany({ orderBy: { endsAt: 'asc' } });
    expect(ents).toHaveLength(2);
    expect(ents[1].endsAt.getTime() - ents[0].endsAt.getTime()).toBeGreaterThan(88 * 86_400_000);
  });

  it('payment.failed marks the order failed and grants nothing', async () => {
    const { o } = await newOrder();
    await webhook({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_f1', order_id: o.razorpayOrderId, amount: o.amountPaise } } } }).expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe('failed');
    expect(await prisma.entitlement.count()).toBe(0);
  });

  describe('coupons', () => {
    beforeEach(() => prisma.coupon.create({ data: { code: 'DEMO30', planId: 'pass_prelims', days: 30, maxUses: 1 } }));

    it('redeems once, case-insensitively, and not twice by the same user', async () => {
      const s = await login(app, 'cp');
      const h = bearer(s.body.accessToken);
      const ok = await http().post('/v1/coupons/redeem').set(h).send({ code: ' demo30 ' }).expect(200);
      expect(ok.body).toHaveLength(1);
      const again = await http().post('/v1/coupons/redeem').set(h).send({ code: 'DEMO30' }).expect(409);
      expect(again.body.error.code).toBe('COUPON_USED');
    });

    it('stops at maxUses and rejects unknown codes', async () => {
      const a = await login(app, 'ca');
      const b = await login(app, 'cb');
      await http().post('/v1/coupons/redeem').set(bearer(a.body.accessToken)).send({ code: 'DEMO30' }).expect(200);
      const res = await http().post('/v1/coupons/redeem').set(bearer(b.body.accessToken)).send({ code: 'DEMO30' }).expect(409);
      expect(res.body.error.code).toBe('COUPON_EXHAUSTED');
      expect((await http().post('/v1/coupons/redeem').set(bearer(b.body.accessToken)).send({ code: 'NOPE' }).expect(400)).body.error.code).toBe('INVALID_COUPON');
    });
  });
});
