import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  actorType: 'admin' | 'user' | 'system';
  actor: string;
  action: string;
  target?: string;
  targetType?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  meta?: unknown;
}

const SENSITIVE = /password|token|secret|otp|recovery|hash|signature/i;
/** Audit rows must never carry credentials, even by accident. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v)]));
  }
  return value;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  log(e: AuditEntry, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).auditLog.create({
      data: {
        actorType: e.actorType,
        actor: e.actor,
        action: e.action,
        target: e.target,
        targetType: e.targetType,
        before: e.before === undefined ? undefined : (redact(e.before) as Prisma.InputJsonValue),
        after: e.after === undefined ? undefined : (redact(e.after) as Prisma.InputJsonValue),
        ip: e.ip,
        meta: e.meta === undefined ? undefined : (redact(e.meta) as Prisma.InputJsonValue),
      },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
