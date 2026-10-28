import { Injectable } from '@nestjs/common';
import { Prisma, SessionRevokeReason } from '@prisma/client';
import { z } from 'zod';
import { SessionService } from '../../auth/session.service';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { bool, code, pageQuery } from '../../common/zod';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminPrincipal } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';

type Actor = { admin: AdminPrincipal; ip?: string };

export const userListQuery = z.object({
  ...pageQuery,
  q: z.string().trim().min(2).max(80).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  paid: bool.optional(),
  targetExam: code.optional(),
  district: z.string().trim().max(60).optional(),
  sort: z.enum(['newest', 'oldest', 'name', 'lastSeen']).default('newest'),
});
export const suspendInput = z.object({ reason: z.string().trim().min(3).max(300) });
export const grantInput = z.object({ planId: z.string().min(2).max(40), days: z.number().int().min(1).max(3650), note: z.string().trim().max(300).optional() });
export const revokeEntitlementInput = z.object({ reason: z.string().trim().min(3).max(300) });

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async list(q: z.infer<typeof userListQuery>) {
    const now = new Date();
    const activeEnt: Prisma.EntitlementWhereInput = { revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } };
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      status: q.status,
      targetExam: q.targetExam,
      district: q.district,
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }] } : {}),
      ...(q.paid === true ? { entitlements: { some: activeEnt } } : q.paid === false ? { entitlements: { none: activeEnt } } : {}),
    };
    const orderBy: Prisma.UserOrderByWithRelationInput[] = q.sort === 'name' ? [{ name: 'asc' }] : q.sort === 'oldest' ? [{ createdAt: 'asc' }] : q.sort === 'lastSeen' ? [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }] : [{ createdAt: 'desc' }];
    const [total, users] = await Promise.all([this.prisma.user.count({ where }), this.prisma.user.findMany({ where, orderBy: [...orderBy, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    const ids = users.map((u) => u.id);
    const [attempts, paid] = await Promise.all([
      this.prisma.attempt.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _count: { _all: true } }),
      this.prisma.entitlement.findMany({ where: { userId: { in: ids }, ...activeEnt }, select: { userId: true } }),
    ]);
    const nAttempts = new Map(attempts.map((a) => [a.userId, a._count._all]));
    const isPaid = new Set(paid.map((p) => p.userId));
    return {
      page: q.page,
      pageSize: q.pageSize,
      total,
      items: users.map((u) => ({ id: u.id, name: u.name, email: u.email, district: u.district, targetExam: u.targetExam, status: u.status, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, paid: isPaid.has(u.id), attempts: nAttempts.get(u.id) ?? 0 })),
    };
  }

  async get(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u) throw notFound('Student');
    const [entitlements, attempts, orders, doubts, sessions, stats] = await Promise.all([
      this.prisma.entitlement.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 20, include: { plan: { select: { id: true, nameEn: true } } } }),
      this.prisma.attempt.findMany({ where: { userId: id }, orderBy: { startedAt: 'desc' }, take: 20, select: { id: true, status: true, isRanked: true, startedAt: true, submittedAt: true, version: { select: { version: true, test: { select: { id: true, titleEn: true } } } }, result: { select: { score: true, maxScore: true, accuracyPct: true } } } }),
      this.prisma.order.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, planId: true, months: true, amountPaise: true, status: true, createdAt: true } }),
      this.prisma.doubt.count({ where: { userId: id } }),
      this.prisma.session.findMany({ where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, platform: true, deviceName: true, createdAt: true, lastSeenAt: true, ip: true } }),
      this.prisma.userTopicStat.findMany({ where: { userId: id }, orderBy: { attempted: 'desc' }, take: 20 }),
    ]);
    // phone and Google subject are deliberately not returned
    const { googleSub: _g, phone: _p, ...profile } = u;
    void _g;
    void _p;
    return { profile, entitlements, attempts, orders, doubts, activeSessions: sessions, topicStats: stats.map((s) => ({ topicCode: s.topicCode, attempted: s.attempted, correct: s.correct, accuracyPct: s.attempted ? Math.round((s.correct / s.attempted) * 100) : null })) };
  }

  async suspend(a: Actor, id: string, reason: string) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u) throw notFound('Student');
    if (u.status === 'suspended') throw conflict('ALREADY_SUSPENDED', 'This student is already suspended');
    await this.prisma.user.update({ where: { id }, data: { status: 'suspended', suspendedAt: new Date(), suspendReason: reason } });
    await this.sessions.revokeAllForUser(id, SessionRevokeReason.SUSPENDED); // effective on the next request
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'user.suspended', targetType: 'user', target: id, before: { status: u.status }, after: { status: 'suspended' }, meta: { reason }, ip: a.ip });
  }

  async activate(a: Actor, id: string) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u) throw notFound('Student');
    if (u.status === 'active') throw conflict('NOT_SUSPENDED', 'This student is not suspended');
    await this.prisma.user.update({ where: { id }, data: { status: 'active', suspendedAt: null, suspendReason: null } });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'user.activated', targetType: 'user', target: id, before: { status: u.status, reason: u.suspendReason }, after: { status: 'active' }, ip: a.ip });
  }

  async revokeSessions(a: Actor, id: string) {
    if (!(await this.prisma.user.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Student');
    await this.sessions.revokeAllForUser(id, SessionRevokeReason.ADMIN);
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'user.sessions_revoked', targetType: 'user', target: id, ip: a.ip });
  }

  async grant(a: Actor, id: string, input: z.infer<typeof grantInput>) {
    if (!(await this.prisma.user.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Student');
    if (!(await this.prisma.plan.findUnique({ where: { id: input.planId } }))) throw badRequest('UNKNOWN_PLAN', 'Plan does not exist');
    const now = new Date();
    const e = await this.prisma.entitlement.create({ data: { userId: id, planId: input.planId, startsAt: now, endsAt: new Date(now.getTime() + input.days * 86_400_000), source: 'admin' } });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'user.access_granted', targetType: 'user', target: id, after: { planId: input.planId, days: input.days, entitlementId: e.id }, meta: { note: input.note }, ip: a.ip });
    return e;
  }

  async revokeEntitlement(a: Actor, entitlementId: string, reason: string) {
    const e = await this.prisma.entitlement.findUnique({ where: { id: entitlementId } });
    if (!e) throw notFound('Entitlement');
    if (e.revokedAt) throw conflict('ALREADY_REVOKED', 'This access was already revoked');
    await this.prisma.entitlement.update({ where: { id: entitlementId }, data: { revokedAt: new Date() } });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'user.access_revoked', targetType: 'user', target: e.userId, before: { entitlementId, endsAt: e.endsAt, source: e.source }, meta: { reason }, ip: a.ip });
  }
}
