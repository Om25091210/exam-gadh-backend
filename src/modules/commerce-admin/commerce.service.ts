import { Injectable } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { BillingService } from '../../billing/billing.service';
import { PaymentGateway } from '../../billing/razorpay.gateway';
import { ApiError, badRequest, conflict, notFound } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminPrincipal } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { couponInput, couponPatch, orderList, planInput, planPatch } from './commerce.schemas';

type Actor = { admin: AdminPrincipal; ip?: string };

@Injectable()
export class CommerceAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gateway: PaymentGateway,
    private readonly billing: BillingService,
  ) {}

  private log(a: Actor, action: string, targetType: string, target: string, before?: unknown, after?: unknown, meta?: unknown) {
    return this.audit.log({ actorType: 'admin', actor: a.admin.id, action, targetType, target, before, after, meta, ip: a.ip });
  }

  // ------------------------------------------------------------------ plans
  async plans() {
    const plans = await this.prisma.plan.findMany({ orderBy: { id: 'asc' }, include: { exams: true, _count: { select: { orders: true, entitlements: true } } } });
    return plans.map(({ exams, _count, ...p }) => ({ ...p, examIds: exams.map((e) => e.examId), orders: _count.orders, entitlements: _count.entitlements }));
  }

  private async checkExams(examIds: string[]) {
    if (examIds.length && (await this.prisma.exam.count({ where: { id: { in: examIds } } })) !== new Set(examIds).size) throw badRequest('UNKNOWN_EXAM', 'Some exams do not exist');
  }

  async createPlan(a: Actor, input: z.infer<typeof planInput>) {
    if (await this.prisma.plan.findUnique({ where: { id: input.id } })) throw conflict('ALREADY_EXISTS', 'A plan with this id exists');
    await this.checkExams(input.examIds);
    const { examIds, ...rest } = input;
    const p = await this.prisma.plan.create({ data: { ...rest, prices: rest.prices as Prisma.InputJsonValue, exams: { create: examIds.map((examId) => ({ examId })) } } });
    await this.log(a, 'plan.created', 'plan', p.id, undefined, input);
    return p;
  }

  async updatePlan(a: Actor, id: string, patch: z.infer<typeof planPatch>) {
    const before = await this.prisma.plan.findUnique({ where: { id }, include: { exams: true } });
    if (!before) throw notFound('Plan');
    if (patch.examIds) await this.checkExams(patch.examIds);
    const { examIds, prices, ...rest } = patch;
    const p = await this.prisma.$transaction(async (tx) => {
      if (examIds) {
        await tx.planExam.deleteMany({ where: { planId: id } });
        await tx.planExam.createMany({ data: examIds.map((examId) => ({ planId: id, examId })) });
      }
      return tx.plan.update({ where: { id }, data: { ...rest, ...(prices ? { prices: prices as Prisma.InputJsonValue } : {}) } });
    });
    // Price changes only affect NEW orders: an order stores the amount it was created with.
    await this.log(a, 'plan.updated', 'plan', id, { prices: before.prices, active: before.active }, patch);
    return p;
  }

  async deletePlan(a: Actor, id: string) {
    const used = await this.prisma.plan.findUnique({ where: { id }, include: { _count: { select: { orders: true, entitlements: true, coupons: true } } } });
    if (!used) throw notFound('Plan');
    if (used._count.orders || used._count.entitlements || used._count.coupons) throw conflict('IN_USE', 'This plan has orders, access or coupons; deactivate it instead');
    await this.prisma.plan.delete({ where: { id } });
    await this.log(a, 'plan.deleted', 'plan', id);
  }

  // ------------------------------------------------------------------ coupons
  coupons() {
    return this.prisma.coupon.findMany({ orderBy: { code: 'asc' } });
  }

  async createCoupon(a: Actor, input: z.infer<typeof couponInput>) {
    if (!(await this.prisma.plan.findUnique({ where: { id: input.planId } }))) throw badRequest('UNKNOWN_PLAN', 'Plan does not exist');
    if (await this.prisma.coupon.findUnique({ where: { code: input.code } })) throw conflict('ALREADY_EXISTS', 'This coupon code exists');
    const c = await this.prisma.coupon.create({ data: input });
    await this.log(a, 'coupon.created', 'coupon', c.code, undefined, input);
    return c;
  }

  async updateCoupon(a: Actor, code: string, patch: z.infer<typeof couponPatch>) {
    const before = await this.prisma.coupon.findUnique({ where: { code } });
    if (!before) throw notFound('Coupon');
    if (patch.maxUses != null && patch.maxUses < before.usedCount) throw badRequest('BELOW_USED', `Already used ${before.usedCount} times`);
    const c = await this.prisma.coupon.update({ where: { code }, data: patch });
    await this.log(a, 'coupon.updated', 'coupon', code, { active: before.active, maxUses: before.maxUses }, patch);
    return c;
  }

  // ------------------------------------------------------------------ orders
  async orders(q: z.infer<typeof orderList>) {
    const where: Prisma.OrderWhereInput = {
      status: q.status as OrderStatus | undefined,
      userId: q.userId,
      planId: q.planId,
      ...(q.q ? { OR: [{ razorpayOrderId: { contains: q.q } }, { payments: { some: { razorpayPaymentId: { contains: q.q } } } }] } : {}),
      ...((q.from || q.to) && { createdAt: { gte: q.from, lte: q.to } }),
    };
    const [total, items, sums] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { user: { select: { id: true, name: true } }, plan: { select: { id: true, nameEn: true } } } }),
      this.prisma.order.aggregate({ where, _sum: { amountPaise: true } }),
    ]);
    return { page: q.page, pageSize: q.pageSize, total, totalAmountPaise: sums._sum.amountPaise ?? 0, items };
  }

  async order(id: string) {
    const o = await this.prisma.order.findUnique({ where: { id }, include: { user: { select: { id: true, name: true, email: true } }, plan: true, payments: { orderBy: { createdAt: 'asc' }, select: { id: true, razorpayPaymentId: true, amountPaise: true, status: true, method: true, createdAt: true } }, entitlement: true } });
    if (!o) throw notFound('Order');
    const invoice = await this.prisma.invoice.findUnique({ where: { orderId: id } });
    return { ...o, invoice };
  }

  /** Full or partial refund through the gateway. Nothing changes here unless the gateway accepted it. */
  async refund(a: Actor, id: string, input: { amountPaise?: number; reason: string }) {
    const o = await this.prisma.order.findUnique({ where: { id }, include: { payments: true, entitlement: true } });
    if (!o) throw notFound('Order');
    if (o.status === 'refunded') throw conflict('ALREADY_REFUNDED', 'This order is already fully refunded');
    if (o.status !== 'paid') throw conflict('NOT_PAID', `A ${o.status} order cannot be refunded`);
    const captured = o.payments.find((p) => p.status === 'captured');
    if (!captured) throw conflict('NO_PAYMENT', 'No captured payment was found for this order');
    const refunded = o.payments.filter((p) => p.status === 'refunded').reduce((n, p) => n + p.amountPaise, 0);
    const remaining = captured.amountPaise - refunded;
    const amount = input.amountPaise ?? remaining;
    if (amount > remaining) throw badRequest('AMOUNT_TOO_HIGH', `At most ${remaining} paise can still be refunded`);

    let refundId: string;
    try {
      refundId = (await this.gateway.refund(captured.razorpayPaymentId, amount, { orderId: o.id, reason: input.reason.slice(0, 200) })).id;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, 'REFUND_FAILED', 'The payment gateway did not accept the refund; nothing was changed');
    }
    const full = amount === remaining;
    await this.prisma.$transaction(async (tx) => {
      await tx.payment.create({ data: { orderId: o.id, razorpayPaymentId: refundId, amountPaise: amount, status: 'refunded', rawEvent: { reason: input.reason, paymentId: captured.razorpayPaymentId } } });
      if (full) {
        await tx.order.update({ where: { id: o.id }, data: { status: 'refunded' } });
        if (o.entitlement && !o.entitlement.revokedAt) await tx.entitlement.update({ where: { id: o.entitlement.id }, data: { revokedAt: new Date() } }); // access ends with a full refund
      }
      await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'order.refunded', targetType: 'order', target: o.id, after: { amountPaise: amount, full }, meta: { reason: input.reason, refundId, userId: o.userId }, ip: a.ip }, tx);
    });
    return { orderId: o.id, refundId, refundedPaise: amount, full, accessRevoked: full && !!o.entitlement };
  }

  // ------------------------------------------------------------------ reconciliation
  /** Compares what the gateway says with what we recorded. Reports only; `repair` fixes one missing payment explicitly. */
  async reconcile(from: Date, to: Date) {
    if (from >= to) throw badRequest('INVALID_RANGE', '"from" must be before "to"');
    if (to.getTime() - from.getTime() > 31 * 86_400_000) throw badRequest('RANGE_TOO_LONG', 'Reconcile at most 31 days at a time');
    const [remote, local] = await Promise.all([
      this.gateway.listPayments(from, to),
      this.prisma.payment.findMany({ where: { createdAt: { gte: from, lte: to }, status: { in: ['captured', 'refunded'] } }, include: { order: { select: { razorpayOrderId: true, amountPaise: true } } } }),
    ]);
    const known = new Map((await this.prisma.payment.findMany({ where: { razorpayPaymentId: { in: remote.map((r) => r.id) } } })).map((p) => [p.razorpayPaymentId, p]));
    const ours = new Map((await this.prisma.order.findMany({ where: { razorpayOrderId: { in: remote.map((r) => r.orderId) } }, select: { razorpayOrderId: true, amountPaise: true, status: true, id: true } })).map((o) => [o.razorpayOrderId, o]));
    const remoteIds = new Set(remote.map((r) => r.id));

    const missingInDb = remote.filter((r) => r.status === 'captured' && !known.has(r.id) && ours.has(r.orderId)).map((r) => ({ paymentId: r.id, orderId: r.orderId, amountPaise: r.amountPaise, createdAt: r.createdAt }));
    const unknownOrder = remote.filter((r) => r.status === 'captured' && !ours.has(r.orderId)).map((r) => ({ paymentId: r.id, orderId: r.orderId, amountPaise: r.amountPaise }));
    const amountMismatch = remote.filter((r) => r.status === 'captured' && known.has(r.id) && known.get(r.id)!.amountPaise !== r.amountPaise).map((r) => ({ paymentId: r.id, gatewayPaise: r.amountPaise, ourPaise: known.get(r.id)!.amountPaise }));
    const missingAtGateway = local.filter((p) => p.status === 'captured' && !remoteIds.has(p.razorpayPaymentId)).map((p) => ({ paymentId: p.razorpayPaymentId, orderId: p.order.razorpayOrderId, amountPaise: p.amountPaise }));
    const refundedAtGateway = remote.filter((r) => r.status === 'refunded' && known.get(r.id)?.status === 'captured').map((r) => ({ paymentId: r.id, orderId: r.orderId }));
    return {
      range: { from, to },
      gatewayPayments: remote.length,
      ourPayments: local.length,
      clean: !missingInDb.length && !unknownOrder.length && !amountMismatch.length && !missingAtGateway.length && !refundedAtGateway.length,
      missingInDb,
      unknownOrder,
      amountMismatch,
      missingAtGateway,
      refundedAtGateway,
    };
  }

  /** The gateway captured the payment but our webhook never recorded it: record it now (grants access, idempotent). */
  async repair(a: Actor, paymentId: string, from: Date, to: Date) {
    const report = await this.reconcile(from, to);
    const hit = report.missingInDb.find((m) => m.paymentId === paymentId);
    if (!hit) throw notFound('Missing payment in this range');
    await this.billing.markPaid({ id: hit.paymentId, order_id: hit.orderId, amount: hit.amountPaise });
    await this.log(a, 'payment.repaired', 'order', hit.orderId, undefined, { paymentId, amountPaise: hit.amountPaise });
    return { repaired: true, paymentId };
  }
}
