import { Inject, Injectable, Logger } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ENV, Env } from '../config/env';
import { ApiError, badRequest, conflict, notFound } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentGateway } from './razorpay.gateway';

const hmacHex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');
const safeEqHex = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const addMonths = (from: Date, months: number) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};

export interface CapturedPayment {
  id: string;
  order_id: string;
  amount: number;
  method?: string;
}

@Injectable()
export class BillingService {
  private readonly log = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async plans() {
    const plans = await this.prisma.plan.findMany({ where: { active: true }, include: { exams: true }, orderBy: { id: 'asc' } });
    return plans.map((p) => ({
      id: p.id,
      nameEn: p.nameEn,
      nameHi: p.nameHi,
      prices: p.prices,
      trialDays: p.trialDays,
      topTier: p.topTier,
      examIds: p.exams.map((e) => e.examId),
    }));
  }

  async createOrder(userId: string, planId: string, months: number) {
    const plan = await this.prisma.plan.findFirst({ where: { id: planId, active: true } });
    if (!plan) throw notFound('Plan');
    const price = (plan.prices as Record<string, number>)[String(months)];
    if (!price) throw badRequest('INVALID_DURATION', `Plan ${planId} is not sold for ${months} months`);
    const amountPaise = Math.round(price * 100);

    const order = await this.prisma.order.create({
      data: { userId, planId, months, amountPaise, razorpayOrderId: `pending_${crypto.randomUUID()}` },
    });
    try {
      const g = await this.gateway.createOrder({
        amountPaise,
        receipt: order.id.slice(0, 40),
        notes: { orderId: order.id, userId, planId, months: String(months) },
      });
      await this.prisma.order.update({ where: { id: order.id }, data: { razorpayOrderId: g.id } });
      return { orderId: order.id, razorpayOrderId: g.id, amountPaise, currency: 'INR', keyId: this.gateway.keyId };
    } catch (e) {
      await this.prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.failed } });
      throw e;
    }
  }

  /** Client-side confirmation: a valid signature proves Razorpay captured this payment for this order. */
  async verify(userId: string, orderId: string, paymentId: string, signature: string) {
    const order = await this.prisma.order.findFirst({ where: { razorpayOrderId: orderId, userId } });
    if (!order) throw notFound('Order');
    const expected = hmacHex(this.env.razorpayKeySecret, `${orderId}|${paymentId}`);
    if (!safeEqHex(expected, signature)) throw badRequest('INVALID_SIGNATURE', 'Payment signature mismatch');
    await this.markPaid({ id: paymentId, order_id: orderId, amount: order.amountPaise });
    return this.entitlements(userId);
  }

  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!rawBody || !signature) throw badRequest('INVALID_SIGNATURE', 'Missing signature');
    const expected = hmacHex(this.env.razorpayWebhookSecret, rawBody);
    if (!this.env.razorpayWebhookSecret || !safeEqHex(expected, signature)) {
      throw badRequest('INVALID_SIGNATURE', 'Webhook signature mismatch');
    }
    const event = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      payload?: { payment?: { entity?: CapturedPayment & { error_description?: string } } };
    };
    const payment = event.payload?.payment?.entity;
    switch (event.event) {
      case 'payment.captured':
      case 'order.paid':
        if (payment) await this.markPaid(payment, event);
        break;
      case 'payment.failed':
        if (payment) await this.markFailed(payment, event);
        break;
      default:
        this.log.debug(`ignored webhook event ${event.event}`);
    }
    return { received: true };
  }

  /** Idempotent: the unique Payment.razorpayPaymentId makes verify + webhook race-safe. */
  async markPaid(p: CapturedPayment, rawEvent?: unknown) {
    const order = await this.prisma.order.findUnique({ where: { razorpayOrderId: p.order_id } });
    if (!order) {
      this.log.warn(`payment ${p.id} for unknown order ${p.order_id}`);
      return;
    }
    if (p.amount !== order.amountPaise) {
      this.log.error(`amount mismatch for order ${order.id}: got ${p.amount}, expected ${order.amountPaise}`);
      throw new ApiError(422, 'AMOUNT_MISMATCH', 'Paid amount does not match the order');
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.create({
          data: {
            orderId: order.id,
            razorpayPaymentId: p.id,
            amountPaise: p.amount,
            method: p.method,
            status: 'captured',
            rawEvent: (rawEvent ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        });
        await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.paid } });
        const now = new Date();
        // Renewals stack: start from the end of the current entitlement for the same plan.
        const current = await tx.entitlement.findFirst({
          where: { userId: order.userId, planId: order.planId, revokedAt: null, endsAt: { gt: now } },
          orderBy: { endsAt: 'desc' },
        });
        const startsAt = current?.endsAt ?? now;
        await tx.entitlement.create({
          data: {
            userId: order.userId,
            planId: order.planId,
            startsAt: current ? now : startsAt,
            endsAt: addMonths(startsAt, order.months),
            source: 'payment',
            orderId: order.id,
          },
        });
        const [{ n: seq }] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('invoice_number_seq') AS n`;
        await tx.invoice.create({ data: { orderId: order.id, number: `EG-${now.getUTCFullYear()}-${String(seq).padStart(6, '0')}` } });
        await tx.auditLog.create({ data: { actor: 'system', actorType: 'system', action: 'payment.captured', targetType: 'order', target: order.id, meta: { paymentId: p.id } } });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return; // already processed
      throw e;
    }
  }

  private async markFailed(p: CapturedPayment, rawEvent: unknown) {
    const order = await this.prisma.order.findUnique({ where: { razorpayOrderId: p.order_id } });
    if (!order || order.status === OrderStatus.paid) return;
    await this.prisma.payment
      .create({
        data: {
          orderId: order.id,
          razorpayPaymentId: p.id,
          amountPaise: p.amount,
          method: p.method,
          status: 'failed',
          rawEvent: rawEvent as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    await this.prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.failed } });
  }

  entitlements(userId: string) {
    return this.prisma.entitlement.findMany({
      where: { userId, revokedAt: null, endsAt: { gt: new Date() } },
      select: { id: true, planId: true, startsAt: true, endsAt: true, source: true },
      orderBy: { endsAt: 'desc' },
    });
  }

  async redeemCoupon(userId: string, rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    const coupon = await this.prisma.coupon.findUnique({ where: { code } });
    const now = new Date();
    if (!coupon || !coupon.active || (coupon.expiresAt && coupon.expiresAt < now)) {
      throw badRequest('INVALID_COUPON', 'This coupon is not valid');
    }
    const already = await this.prisma.auditLog.count({ where: { actor: userId, action: 'coupon.redeem', target: code } });
    if (already) throw conflict('COUPON_USED', 'You have already used this coupon');

    await this.prisma.$transaction(async (tx) => {
      // Atomic cap check: the row only updates while uses remain.
      const claimed = await tx.$executeRaw`
        UPDATE "Coupon" SET "usedCount" = "usedCount" + 1
        WHERE "code" = ${code} AND ("maxUses" IS NULL OR "usedCount" < "maxUses")`;
      if (claimed === 0) throw conflict('COUPON_EXHAUSTED', 'This coupon has no uses left');
      await tx.entitlement.create({
        data: { userId, planId: coupon.planId, endsAt: new Date(now.getTime() + coupon.days * 86_400_000), source: 'coupon' },
      });
      await tx.auditLog.create({ data: { actor: userId, action: 'coupon.redeem', target: code } });
    });
    return this.entitlements(userId);
  }
}
