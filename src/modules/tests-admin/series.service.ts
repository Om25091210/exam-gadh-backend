import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminPrincipal } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { seriesInput, seriesItems, seriesPatch } from './tests-admin.schemas';

type Actor = { admin: AdminPrincipal; ip?: string };

@Injectable()
export class SeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.testSeries.findMany({ orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }], include: { _count: { select: { items: true, enrollments: true } } } });
  }

  async get(id: string) {
    const s = await this.prisma.testSeries.findUnique({ where: { id }, include: { items: { orderBy: { position: 'asc' }, include: { test: { select: { id: true, titleEn: true, titleHi: true, kind: true, publishedVersionId: true, archived: true } } } }, _count: { select: { enrollments: true } } } });
    if (!s) throw notFound('Series');
    return s;
  }

  async create(a: Actor, input: z.infer<typeof seriesInput>) {
    if (!(await this.prisma.exam.findUnique({ where: { id: input.examId } }))) throw badRequest('UNKNOWN_EXAM', 'Exam does not exist');
    const s = await this.prisma.testSeries.create({ data: input });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'series.created', targetType: 'series', target: s.id, after: input, ip: a.ip });
    return s;
  }

  async patch(a: Actor, id: string, patch: z.infer<typeof seriesPatch>) {
    const before = await this.prisma.testSeries.findUnique({ where: { id }, include: { items: true } });
    if (!before) throw notFound('Series');
    if (patch.status === 'published' && before.items.length === 0) throw conflict('EMPTY_SERIES', 'Add at least one test before publishing a series');
    const s = await this.prisma.testSeries.update({ where: { id }, data: patch });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'series.updated', targetType: 'series', target: id, before: { status: before.status, access: before.access }, after: patch, ip: a.ip });
    return s;
  }

  async setItems(a: Actor, id: string, input: z.infer<typeof seriesItems>) {
    if (!(await this.prisma.testSeries.findUnique({ where: { id } }))) throw notFound('Series');
    if (new Set(input.testIds).size !== input.testIds.length) throw badRequest('DUPLICATE_TEST', 'A test can be in a series only once');
    const found = await this.prisma.test.count({ where: { id: { in: input.testIds } } });
    if (found !== input.testIds.length) throw badRequest('UNKNOWN_TEST', 'Some tests do not exist');
    await this.prisma.$transaction([this.prisma.testSeriesItem.deleteMany({ where: { seriesId: id } }), this.prisma.testSeriesItem.createMany({ data: input.testIds.map((testId, position) => ({ seriesId: id, testId, position })) })]);
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: 'series.items_set', targetType: 'series', target: id, meta: { count: input.testIds.length }, ip: a.ip });
  }
}
