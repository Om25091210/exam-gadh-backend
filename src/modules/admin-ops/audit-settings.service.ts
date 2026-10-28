import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest } from '../../common/api-error';
import { pageQuery } from '../../common/zod';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminPrincipal } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { SETTING_DEFAULTS, SettingKey, SettingsService } from '../settings/settings.service';

export const auditQuery = z.object({
  ...pageQuery,
  actor: z.string().max(80).optional(),
  actorType: z.enum(['admin', 'user', 'system']).optional(),
  action: z.string().max(80).optional(), // prefix match, e.g. "question." or "test.key"
  targetType: z.string().max(40).optional(),
  target: z.string().max(80).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** One schema per setting: a wrong type or an out-of-range value is rejected, never stored. */
const hours = z.number().int().min(0).max(23);
export const SETTING_SCHEMAS: Record<SettingKey, z.ZodType> = {
  'attempt.multiClientPolicy': z.enum(['takeover', 'block']),
  'attempt.lockStaleSec': z.number().int().min(10).max(600),
  'content.requireBothLanguages': z.boolean(),
  'doubts.dailyQuota': z.number().int().min(1).max(50),
  'doubts.freeMonthly': z.number().int().min(0).max(100),
  'doubts.slaHours': z.number().int().min(1).max(240),
  'notifications.quietHours': z.tuple([hours, hours]),
  'notifications.dailyCap': z.number().int().min(0).max(20),
};

@Injectable()
export class AuditSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async auditList(q: z.infer<typeof auditQuery>) {
    const where: Prisma.AuditLogWhereInput = {
      actor: q.actor,
      actorType: q.actorType,
      targetType: q.targetType,
      target: q.target,
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...((q.from || q.to) && { createdAt: { gte: q.from, lte: q.to } }),
    };
    const [total, items] = await Promise.all([this.prisma.auditLog.count({ where }), this.prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { page: q.page, pageSize: q.pageSize, total, items };
  }

  async allSettings() {
    return { values: await this.settings.all(), defaults: SETTING_DEFAULTS };
  }

  async setSetting(a: { admin: AdminPrincipal; ip?: string }, key: string, value: unknown) {
    if (!(key in SETTING_SCHEMAS)) throw badRequest('UNKNOWN_SETTING', `Unknown setting ${key}`);
    const parsed = SETTING_SCHEMAS[key as SettingKey].safeParse(value);
    if (!parsed.success) throw badRequest('INVALID_VALUE', 'The value is not valid for this setting', parsed.error.issues.map((i) => i.message));
    const before = (await this.settings.all())[key];
    await this.settings.set(key as SettingKey, parsed.data, a.admin.id);
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'setting.changed', targetType: 'setting', target: key, before: { value: before }, after: { value: parsed.data }, ip: a.ip });
    return { key, value: parsed.data };
  }
}
