import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { notFound } from '../../common/api-error';
import { QuestionBody } from '../questions/question.schemas';

export interface Snapshot {
  type: string;
  body: QuestionBody;
  answer: number;
  passage: { en?: string; hi?: string } | null;
  topicCode: string;
  subtopicCode: string | null;
  difficulty: number;
  imageKey: string | null;
}

export type LoadedVersion = Prisma.TestVersionGetPayload<{
  include: { sections: true; questions: true };
}> & { test: { id: string; examId: string; mode: string; access: string; titleEn: string; titleHi: string; kind: string } };

/** Published and archived versions are immutable, so they are safe to cache in memory. */
@Injectable()
export class VersionLoader {
  private cache = new Map<string, LoadedVersion>();
  private static readonly MAX = 64;

  constructor(private readonly prisma: PrismaService) {}

  async load(versionId: string): Promise<LoadedVersion> {
    const hit = this.cache.get(versionId);
    if (hit) return hit;
    const v = await this.prisma.testVersion.findUnique({
      where: { id: versionId },
      include: {
        sections: { orderBy: { position: 'asc' } },
        questions: { orderBy: { position: 'asc' } },
        test: { select: { id: true, examId: true, mode: true, access: true, titleEn: true, titleHi: true, kind: true } },
      },
    });
    if (!v) throw notFound('Test version');
    if (v.status !== 'draft') {
      if (this.cache.size >= VersionLoader.MAX) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(versionId, v as LoadedVersion);
    }
    return v as LoadedVersion;
  }

  /** Drops the in-memory copy (after an audited answer-key correction). */
  invalidate(versionId: string) {
    this.cache.delete(versionId);
  }

  sectionPositionById(v: LoadedVersion): Map<string, number> {
    return new Map(v.sections.map((s) => [s.id, s.position]));
  }
}

export const snapshotOf = (q: { snapshot: Prisma.JsonValue | null }): Snapshot => q.snapshot as unknown as Snapshot;
