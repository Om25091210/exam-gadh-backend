import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { notFound } from '../../common/api-error';
import { Clock } from '../../common/clock';
import { istDayStart } from '../../common/ist';
import { istDateString } from '../../common/ist';
import { pageQuery, skipTake } from '../../common/zod';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { DEFAULT_TEMPLATES, NotificationKind, render } from './templates';

export const listQuery = z.object({ ...pageQuery, unread: z.enum(['true', 'false']).optional() });

export interface NotifyInput {
  userId: string;
  kind: NotificationKind;
  vars?: Record<string, string | number>;
  /** Same (user, key) never notifies twice, so jobs may run repeatedly or on several servers. */
  dedupeKey?: string;
  data?: Record<string, unknown>;
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Stores an in-app notification. Returns false when it was skipped (duplicate, or a reminder over the daily cap).
   * Push/e-mail/SMS delivery is not built yet (docs/BLOCKERS.md BL-4); the in-app inbox is the single source.
   */
  async notify(n: NotifyInput): Promise<boolean> {
    const custom = await this.prisma.notificationTemplate.findUnique({ where: { key: n.kind } });
    const t = custom ?? DEFAULT_TEMPLATES[n.kind];
    const nudge = DEFAULT_TEMPLATES[n.kind].nudge;
    const vars = n.vars ?? {};
    if (nudge && (await this.overCap(n.userId))) return false;
    try {
      await this.prisma.notification.create({
        data: {
          userId: n.userId,
          kind: n.kind,
          titleEn: render(t.titleEn, vars),
          titleHi: render(t.titleHi, vars),
          bodyEn: render(t.bodyEn, vars),
          bodyHi: render(t.bodyHi, vars),
          data: { ...(n.data ?? {}), ...(n.dedupeKey ? { dedupeKey: n.dedupeKey } : {}) } as Prisma.InputJsonValue,
          createdAt: this.clock.now(),
        },
      });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false; // already sent
      throw e;
    }
  }

  private async overCap(userId: string) {
    const cap = await this.settings.get('notifications.dailyCap');
    const from = istDayStart(istDateString(this.clock.now()));
    const sent = await this.prisma.notification.count({ where: { userId, createdAt: { gte: from }, kind: { in: ['live_test', 'announcement', 'plan_expiring'] } } });
    return sent >= cap;
  }

  async list(userId: string, q: z.infer<typeof listQuery>) {
    const where: Prisma.NotificationWhereInput = { userId, readAt: q.unread === 'true' ? null : undefined };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      items: items.map((n) => ({ id: n.id, kind: n.kind, titleEn: n.titleEn, titleHi: n.titleHi, bodyEn: n.bodyEn, bodyHi: n.bodyHi, data: n.data, read: !!n.readAt, createdAt: n.createdAt })),
      total, unread, page: q.page, pageSize: q.pageSize,
    };
  }

  async unreadCount(userId: string) {
    return { unread: await this.prisma.notification.count({ where: { userId, readAt: null } }) };
  }

  async markRead(userId: string, id: string) {
    const r = await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: this.clock.now() } });
    if (r.count === 0 && !(await this.prisma.notification.findFirst({ where: { id, userId } }))) throw notFound('Notification');
  }

  async markAllRead(userId: string) {
    const r = await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: this.clock.now() } });
    return { updated: r.count };
  }
}
