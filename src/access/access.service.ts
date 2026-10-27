import { Injectable } from '@nestjs/common';
import { AccessLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active paid entitlement covering `examId` (a plan with no exams covers every exam). */
  async hasPaidAccess(userId: string, examId?: string): Promise<boolean> {
    const now = new Date();
    const count = await this.prisma.entitlement.count({
      where: {
        userId,
        revokedAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
        ...(examId
          ? { plan: { OR: [{ exams: { none: {} } }, { exams: { some: { examId } } }] } }
          : {}),
      },
    });
    return count > 0;
  }

  async canAccess(userId: string, level: AccessLevel, examId?: string): Promise<boolean> {
    return level === AccessLevel.free || this.hasPaidAccess(userId, examId);
  }
}
