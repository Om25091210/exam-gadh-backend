import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeGateway, bearer, createApp, FakeClock, login, resetDb, rzpSignature, signedInAdmin } from './helpers';
import { baseTaxonomy } from './fixtures';

const WEBHOOK = 'whsec_test_value';

describe('admin: plans, coupons, orders, refunds, reconciliation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clock: FakeClock;
  let gateway: FakeGateway;
  beforeAll(async () => ({ app, prisma, clock, gateway } = await createApp()));
  afterAll(() => app.close());
  beforeEach(async () => {
    clock.reset();
    gateway.payments = [];
    gateway.refunds = [];
    gateway.failRefunds = false;
    await resetDb(prisma);
    await baseTaxonomy(prisma);
  });
  const http = () => request(app.getHttpServer());

  const plan = { id: 'Pass_Prelims', nameEn: 'Prelims Pass', nameHi: 'प्रारंभिक पास', prices: { '3': 399, '6': 699 }, trialDays: 7, examIds: ['cgpsc'] };

  async function purchase(sub = 'buyer') {
    const s = await login(app, sub);
    const h = bearer(s.body.accessToken);
    const o = (await http().post('/v1/billing/orders').set(h).send({ planId: 'pass_prelims', months: 3 }).expect(201)).body;
    const raw = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: `pay_${sub}`, order_id: o.razorpayOrderId, amount: o.amountPaise, method: 'upi' } } } });
    await http().post('/v1/billing/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', rzpSignature(WEBHOOK, raw)).send(raw).expect(200);
    return { s, h, order: o, paymentId: `pay_${sub}` };
  }

  describe('plans and coupons', () => {
    it('roles: support can look, only plans:write / coupons:write can change', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const support = await signedInAdmin(app, prisma, clock, 'SUPPORT');
      const editor = await signedInAdmin(app, prisma, clock, 'CONTENT_EDITOR');
      await http().post('/v1/admin/plans').set(support.headers).send(plan).expect(403);
      await http().post('/v1/admin/plans').set(editor.headers).send(plan).expect(403);
      await http().post('/v1/admin/plans').set(admin.headers).send(plan).expect(201);
      await http().get('/v1/admin/plans').set(support.headers).expect(200);
      await http().get('/v1/admin/plans').set(editor.headers).expect(403);
      await http().post('/v1/admin/coupons').set(support.headers).send({ code: 'X', planId: 'pass_prelims', days: 5 }).expect(403);
    });

    it('creates, validates and edits plans; price changes never touch existing orders', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const created = (await http().post('/v1/admin/plans').set(admin.headers).send(plan).expect(201)).body;
      expect(created.id).toBe('pass_prelims');
      const bad = (b: object) => http().post('/v1/admin/plans').set(admin.headers).send({ ...plan, id: 'other', ...b });
      await bad({ prices: {} }).expect(400);
      await bad({ prices: { '3': 0 } }).expect(400);
      await bad({ prices: { '3': 99.5 } }).expect(400);
      await bad({ prices: { '5': 100 } }).expect(400);
      expect((await bad({ id: 'pass_prelims' }).expect(409)).body.error.code).toBe('ALREADY_EXISTS');
      expect((await bad({ examIds: ['nope'] }).expect(400)).body.error.code).toBe('UNKNOWN_EXAM');
      const { order } = await purchase();
      expect(order.amountPaise).toBe(39_900);
      await http().patch('/v1/admin/plans/pass_prelims').set(admin.headers).send({ prices: { '3': 499, '6': 799 }, examIds: [] }).expect(200);
      const stored = await prisma.order.findFirstOrThrow();
      expect(stored.amountPaise).toBe(39_900);
      const s2 = await login(app, 'second');
      expect((await http().post('/v1/billing/orders').set(bearer(s2.body.accessToken)).send({ planId: 'pass_prelims', months: 3 }).expect(201)).body.amountPaise).toBe(49_900);
      expect((await http().get('/v1/plans').expect(200)).body[0].examIds).toEqual([]);
      expect((await http().delete('/v1/admin/plans/pass_prelims').set(admin.headers).expect(409)).body.error.code).toBe('IN_USE');
      await http().patch('/v1/admin/plans/pass_prelims').set(admin.headers).send({ active: false }).expect(200);
      expect((await http().get('/v1/plans').expect(200)).body).toHaveLength(0);
      await http().patch('/v1/admin/plans/nope').set(admin.headers).send({ active: false }).expect(404);
    });

    it('manages coupons and the student can redeem them', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      await http().post('/v1/admin/plans').set(admin.headers).send(plan).expect(201);
      const c = (await http().post('/v1/admin/coupons').set(admin.headers).send({ code: 'diwali30', planId: 'pass_prelims', days: 30, maxUses: 2 }).expect(201)).body;
      expect(c.code).toBe('DIWALI30');
      expect((await http().post('/v1/admin/coupons').set(admin.headers).send({ code: 'DIWALI30', planId: 'pass_prelims', days: 30 }).expect(409)).body.error.code).toBe('ALREADY_EXISTS');
      await http().post('/v1/admin/coupons').set(admin.headers).send({ code: 'BADPLAN', planId: 'nope', days: 30 }).expect(400);
      await http().post('/v1/admin/coupons').set(admin.headers).send({ code: 'zero', planId: 'pass_prelims', days: 0 }).expect(400);
      const s = await login(app, 'stu');
      await http().post('/v1/coupons/redeem').set(bearer(s.body.accessToken)).send({ code: 'diwali30' }).expect(200);
      expect((await http().patch('/v1/admin/coupons/DIWALI30').set(admin.headers).send({ maxUses: 0 }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
      await http().patch('/v1/admin/coupons/diwali30').set(admin.headers).send({ active: false }).expect(200);
      const s2 = await login(app, 'stu2');
      expect((await http().post('/v1/coupons/redeem').set(bearer(s2.body.accessToken)).send({ code: 'DIWALI30' }).expect(400)).body.error.code).toBe('INVALID_COUPON');
      const list = (await http().get('/v1/admin/coupons').set(admin.headers).expect(200)).body;
      expect(list[0]).toMatchObject({ code: 'DIWALI30', usedCount: 1, active: false });
    });
  });

  describe('orders', () => {
    it('lists and filters orders, shows payments and a numbered receipt', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const support = await signedInAdmin(app, prisma, clock, 'SUPPORT');
      await http().post('/v1/admin/plans').set(admin.headers).send(plan).expect(201);
      const a = await purchase('anita');
      await purchase('bhavna');
      const s = await login(app, 'chitra');
      await http().post('/v1/billing/orders').set(bearer(s.body.accessToken)).send({ planId: 'pass_prelims', months: 3 }).expect(201); // never paid
      const all = (await http().get('/v1/admin/orders').set(support.headers).expect(200)).body;
      expect(all.total).toBe(3);
      expect((await http().get('/v1/admin/orders?status=paid').set(support.headers).expect(200)).body).toMatchObject({ total: 2, totalAmountPaise: 79_800 });
      expect((await http().get(`/v1/admin/orders?q=${a.paymentId}`).set(support.headers).expect(200)).body.total).toBe(1);
      expect((await http().get(`/v1/admin/orders?userId=${a.s.body.user.id}`).set(support.headers).expect(200)).body.total).toBe(1);
      const detail = (await http().get(`/v1/admin/orders/${all.items.find((o: { status: string }) => o.status === 'paid').id}`).set(support.headers).expect(200)).body;
      expect(detail.payments).toHaveLength(1);
      expect(detail.invoice.number).toMatch(/^EG-\d{4}-\d{6}$/);
      expect(detail.entitlement).toBeTruthy();
      const numbers = (await prisma.invoice.findMany()).map((i) => i.number);
      expect(new Set(numbers).size).toBe(2); // receipt numbers are unique and sequential
    });
  });

  describe('refunds', () => {
    it('a full refund goes through the gateway, ends access and is audited; it cannot be repeated', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      await http().post('/v1/admin/plans').set(admin.headers).send(plan).expect(201);
      const p = await purchase();
      const orderId = (await prisma.order.findFirstOrThrow()).id;
      expect((await http().get('/v1/entitlements').set(p.h).expect(200)).body).toHaveLength(1);
      const r = await http().post(`/v1/admin/orders/${orderId}/refund`).set(admin.headers).send({ reason: 'Duplicate purchase' }).expect(200);
      expect(r.body).toMatchObject({ refundedPaise: 39_900, full: true, accessRevoked: true });
      expect(gateway.refunds).toEqual([{ paymentId: p.paymentId, amountPaise: 39_900 }]);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('refunded');
      expect((await http().get('/v1/entitlements').set(p.h).expect(200)).body).toHaveLength(0);
      expect((await http().post(`/v1/admin/orders/${orderId}/refund`).set(admin.headers).send({ reason: 'Duplicate purchase' }).expect(409)).body.error.code).toBe('ALREADY_REFUNDED');
      expect(gateway.refunds).toHaveLength(1);
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.refunded' } });
      expect(log).toMatchObject({ actor: admin.id, target: orderId });
      const dash = (await http().get('/v1/admin/dashboard').set(admin.headers).expect(200)).body;
      expect(dash.revenue).toMatchObject({ grossPaise: 39_900, refundedPaise: 39_900, netPaise: 0 });
    });

    it('a partial refund keeps access; more than the remainder is refused; only publishers of refunds can do it', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const support = await signedInAdmin(app, prisma, clock, 'SUPPORT');
      await http().post('/v1/admin/plans').set(admin.headers).send(plan).expect(201);
      const p = await purchase();
      const orderId = (await prisma.order.findFirstOrThrow()).id;
      await http().post(`/v1/admin/orders/${orderId}/refund`).set(support.headers).send({ reason: 'Please refund' }).expect(403);
      const half = await http().post(`/v1/admin/orders/${orderId}/refund`).set(admin.headers).send({ amountPaise: 10_000, reason: 'Goodwill gesture' }).expect(200);
      expect(half.body).toMatchObject({ full: false, accessRevoked: false });
      expect((await http().get('/v1/entitlements').set(p.h).expect(200)).body).toHaveLength(1);
      expect((await http().post(`/v1/admin/orders/${orderId}/refund`).set(admin.headers).send({ amountPaise: 35_000, reason: 'Too much money' }).expect(400)).body.error.code).toBe('AMOUNT_TOO_HIGH');
      const rest = await http().post(`/v1/admin/orders/${orderId}/refund`).set(admin.headers).send({ reason: 'Refund the rest' }).expect(200);
      expect(rest.body).toMatchObject({ refundedPaise: 29_900, full: true });
      await http().post(`/v1/admin/orders/${orderId}/refund`).set(admin.headers).send({ reason: 'x' }).expect(400);
    });

    it('if the gateway refuses, nothing changes; unpaid orders cannot be refunded', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      await http().post('/v1/admin/plans').set(admin.headers).send(plan).expect(201);
      await purchase();
      const orderId = (await prisma.order.findFirstOrThrow()).id;
      gateway.failRefunds = true;
      expect((await http().post(`/v1/admin/orders/${orderId}/refund`).set(admin.headers).send({ reason: 'Gateway is down' }).expect(502)).body.error.code).toBe('REFUND_FAILED');
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('paid');
      expect(await prisma.entitlement.count({ where: { revokedAt: null } })).toBe(1);
      expect(await prisma.payment.count({ where: { status: 'refunded' } })).toBe(0);
      const s = await login(app, 'unpaid');
      await http().post('/v1/billing/orders').set(bearer(s.body.accessToken)).send({ planId: 'pass_prelims', months: 3 }).expect(201);
      const unpaid = await prisma.order.findFirstOrThrow({ where: { status: 'created' } });
      expect((await http().post(`/v1/admin/orders/${unpaid.id}/refund`).set(admin.headers).send({ reason: 'Not paid yet' }).expect(409)).body.error.code).toBe('NOT_PAID');
    });
  });

  describe('reconciliation', () => {
    const range = () => ({ from: new Date(Date.now() - 864e5).toISOString(), to: new Date(Date.now() + 864e5).toISOString() });

    it('reports a clean day, then every kind of mismatch, and repairs a missed payment explicitly', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      await http().post('/v1/admin/plans').set(admin.headers).send(plan).expect(201);
      const ok = await purchase('ok');
      const stored = await prisma.payment.findFirstOrThrow({ where: { razorpayPaymentId: ok.paymentId } });
      gateway.payments = [{ id: ok.paymentId, orderId: ok.order.razorpayOrderId, amountPaise: stored.amountPaise, status: 'captured', createdAt: new Date() }];
      const clean = (await http().post('/v1/admin/orders/reconcile').set(admin.headers).send(range()).expect(200)).body;
      expect(clean).toMatchObject({ clean: true, gatewayPayments: 1, ourPayments: 1 });

      // a payment captured at the gateway whose webhook we never received
      const s = await login(app, 'late');
      const late = (await http().post('/v1/billing/orders').set(bearer(s.body.accessToken)).send({ planId: 'pass_prelims', months: 3 }).expect(201)).body;
      gateway.payments.push(
        { id: 'pay_missed', orderId: late.razorpayOrderId, amountPaise: late.amountPaise, status: 'captured', createdAt: new Date() },
        { id: 'pay_stranger', orderId: 'order_unknown', amountPaise: 100, status: 'captured', createdAt: new Date() },
      );
      gateway.payments[0] = { ...gateway.payments[0], amountPaise: stored.amountPaise + 100 };
      const bad = (await http().post('/v1/admin/orders/reconcile').set(admin.headers).send(range()).expect(200)).body;
      expect(bad.clean).toBe(false);
      expect(bad.missingInDb).toEqual([expect.objectContaining({ paymentId: 'pay_missed', amountPaise: late.amountPaise })]);
      expect(bad.unknownOrder).toEqual([expect.objectContaining({ paymentId: 'pay_stranger' })]);
      expect(bad.amountMismatch).toEqual([{ paymentId: ok.paymentId, gatewayPaise: stored.amountPaise + 100, ourPaise: stored.amountPaise }]);

      const fix = (await http().post('/v1/admin/orders/reconcile/repair').set(admin.headers).send({ ...range(), razorpayPaymentId: 'pay_missed' }).expect(200)).body;
      expect(fix).toMatchObject({ repaired: true });
      expect((await http().get('/v1/entitlements').set(bearer(s.body.accessToken)).expect(200)).body).toHaveLength(1);
      expect((await http().post('/v1/admin/orders/reconcile/repair').set(admin.headers).send({ ...range(), razorpayPaymentId: 'pay_missed' }).expect(404)).body.error.code).toBe('NOT_FOUND'); // no longer missing
      // we hold a captured payment the gateway does not list
      gateway.payments = [];
      expect((await http().post('/v1/admin/orders/reconcile').set(admin.headers).send(range()).expect(200)).body.missingAtGateway).toHaveLength(2);
    });

    it('validates the range and the role', async () => {
      const admin = await signedInAdmin(app, prisma, clock, 'ADMIN');
      const support = await signedInAdmin(app, prisma, clock, 'SUPPORT');
      await http().post('/v1/admin/orders/reconcile').set(support.headers).send(range()).expect(403);
      await http().post('/v1/admin/orders/reconcile').set(admin.headers).send({ from: range().to, to: range().from }).expect(400);
      expect((await http().post('/v1/admin/orders/reconcile').set(admin.headers).send({ from: new Date(Date.now() - 40 * 864e5).toISOString(), to: new Date().toISOString() }).expect(400)).body.error.code).toBe('RANGE_TOO_LONG');
      await http().post('/v1/admin/orders/reconcile').set(admin.headers).send({}).expect(400);
    });
  });
});
