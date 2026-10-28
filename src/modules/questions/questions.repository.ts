import { Injectable } from '@nestjs/common';
import { ContentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class QuestionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  where(f: { status?: ContentStatus; type?: string; topicCode?: string; subtopicCode?: string; difficulty?: number; source?: string; pyqYear?: number; missing?: 'hi' | 'en' | 'any'; reported?: boolean; q?: string; tag?: string }): Prisma.QuestionWhereInput {
    return {
      status: f.status,
      type: f.type as never,
      topicCode: f.topicCode,
      subtopicCode: f.subtopicCode,
      difficulty: f.difficulty,
      source: f.source,
      pyqYear: f.pyqYear,
      ...(f.missing === 'hi' ? { hasHi: false } : f.missing === 'en' ? { hasEn: false } : f.missing === 'any' ? { OR: [{ hasHi: false }, { hasEn: false }] } : {}),
      ...(f.reported ? { reportedCount: { gt: 0 } } : {}),
      ...(f.q ? { searchText: { contains: f.q.toLowerCase(), mode: 'insensitive' as const } } : {}),
      ...(f.tag ? { tags: { has: f.tag } } : {}),
    };
  }

  list(where: Prisma.QuestionWhereInput, skip: number, take: number) {
    return Promise.all([
      this.prisma.question.count({ where }),
      this.prisma.question.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true, code: true, type: true, topicCode: true, subtopicCode: true, difficulty: true, status: true, hasEn: true, hasHi: true, version: true, reportedCount: true, source: true, pyqYear: true, tags: true, body: true, updatedAt: true },
      }),
    ]);
  }

  byId(id: string) {
    return this.prisma.question.findUnique({ where: { id }, include: { passage: true } });
  }

  byIds(ids: string[]) {
    return this.prisma.question.findMany({ where: { id: { in: ids } }, include: { passage: true } });
  }

  byHash(hash: string, exceptId?: string) {
    return this.prisma.question.findMany({ where: { contentHash: hash, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, code: true, status: true, topicCode: true } });
  }

  history(id: string) {
    return this.prisma.questionVersion.findMany({ where: { questionId: id }, orderBy: { version: 'desc' } });
  }

  usage(id: string) {
    return this.prisma.testVersionQuestion.findMany({ where: { questionId: id }, select: { version: { select: { id: true, version: true, status: true, test: { select: { id: true, titleEn: true } } } } } });
  }

  duplicateGroups() {
    return this.prisma.$queryRaw<Array<{ contentHash: string; ids: string[]; codes: Array<string | null> }>>`
      SELECT "contentHash", array_agg(id::text ORDER BY "createdAt") AS ids, array_agg(code ORDER BY "createdAt") AS codes
      FROM "Question" WHERE status <> 'archived' GROUP BY "contentHash" HAVING count(*) > 1 ORDER BY count(*) DESC LIMIT 200`;
  }
}
