import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Clock } from '../../common/clock';

/** Runtime settings with documented defaults; admin-editable, cached for 30 s. */
export const SETTING_DEFAULTS = {
  // Two tabs on one attempt: 'takeover' (newest tab wins) or 'block' (second tab is refused while the first is alive).
  'attempt.multiClientPolicy': 'takeover' as 'takeover' | 'block',
  // Seconds without a heartbeat after which an attempt lock is considered abandoned.
  'attempt.lockStaleSec': 45,
  // Publishing needs both Hindi and English on every question.
  'content.requireBothLanguages': false,
  'doubts.dailyQuota': 3,
  'doubts.freeMonthly': 2,
  'doubts.slaHours': 48,
  'notifications.quietHours': [22, 7] as [number, number],
  'notifications.dailyCap': 2,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

@Injectable()
export class SettingsService {
  private cache = new Map<string, { value: unknown; until: number }>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  async get<K extends SettingKey>(key: K): Promise<(typeof SETTING_DEFAULTS)[K]> {
    const hit = this.cache.get(key);
    const now = this.clock.now().getTime();
    if (hit && hit.until > now) return hit.value as (typeof SETTING_DEFAULTS)[K];
    const row = await this.prisma.setting.findUnique({ where: { key } });
    const value = (row ? row.value : SETTING_DEFAULTS[key]) as (typeof SETTING_DEFAULTS)[K];
    this.cache.set(key, { value, until: now + 30_000 });
    return value;
  }

  clearCache() {
    this.cache.clear();
  }

  async all() {
    const rows = await this.prisma.setting.findMany();
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    return Object.fromEntries(Object.entries(SETTING_DEFAULTS).map(([k, d]) => [k, stored.get(k) ?? d]));
  }

  async set(key: SettingKey, value: unknown, adminId?: string) {
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value: value as never, updatedBy: adminId },
      update: { value: value as never, updatedBy: adminId },
    });
    this.cache.delete(key);
  }
}
