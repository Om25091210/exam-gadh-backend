import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z, ZodType } from 'zod';
import { ApiError, badRequest, conflict, notFound } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminPrincipal } from '../admin-auth/admin-auth.types';
import { AuditService } from '../audit/audit.service';
import { announcementSchema, calendarSchema, cannedSchema, currentAffairSchema, faqSchema, interviewSchema, materialSchema, noteSchema, templateSchema } from './content.schemas';

type Actor = { admin: AdminPrincipal; ip?: string };
type Delegate = {
  findMany(a: unknown): Promise<Record<string, unknown>[]>;
  count(a: unknown): Promise<number>;
  findUnique(a: unknown): Promise<Record<string, unknown> | null>;
  create(a: unknown): Promise<Record<string, unknown>>;
  update(a: unknown): Promise<Record<string, unknown>>;
  delete(a: unknown): Promise<unknown>;
};

export interface EntityConfig {
  name: string;
  delegate: string;
  idField: string;
  schema: ZodType;
  /** how "published" is stored: an enum column or a boolean */
  publishVia?: { field: 'status' | 'published' };
  search: string[];
  orderBy: Record<string, 'asc' | 'desc'>[];
  filters: string[];
}

export const ENTITIES: Record<string, EntityConfig> = {
  materials: { name: 'Material', delegate: 'material', idField: 'id', schema: materialSchema, publishVia: { field: 'status' }, search: ['titleEn', 'titleHi'], orderBy: [{ sort: 'asc' }, { createdAt: 'desc' }], filters: ['status', 'examId', 'subjectCode', 'kind', 'access'] },
  'current-affairs': { name: 'Current affair', delegate: 'currentAffair', idField: 'id', schema: currentAffairSchema, publishVia: { field: 'status' }, search: ['titleEn', 'titleHi'], orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], filters: ['status', 'category', 'topicCode', 'access'] },
  announcements: { name: 'Announcement', delegate: 'announcement', idField: 'id', schema: announcementSchema, publishVia: { field: 'status' }, search: ['titleEn', 'titleHi'], orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }], filters: ['status', 'examId', 'kind'] },
  calendar: { name: 'Calendar event', delegate: 'calendarEvent', idField: 'id', schema: calendarSchema, search: ['labelEn', 'labelHi'], orderBy: [{ date: 'asc' }], filters: ['examId', 'stage'] },
  faqs: { name: 'FAQ', delegate: 'faq', idField: 'id', schema: faqSchema, search: ['qEn', 'qHi', 'keywords'], orderBy: [{ qEn: 'asc' }], filters: [] },
  interview: { name: 'Interview question', delegate: 'interviewQuestion', idField: 'id', schema: interviewSchema, search: ['qEn', 'qHi'], orderBy: [{ category: 'asc' }, { qEn: 'asc' }], filters: ['examId', 'category'] },
  notes: { name: 'Note', delegate: 'note', idField: 'id', schema: noteSchema, publishVia: { field: 'published' }, search: ['titleEn', 'titleHi', 'id'], orderBy: [{ id: 'asc' }], filters: ['subjectCode', 'published', 'access'] },
  'canned-replies': { name: 'Canned reply', delegate: 'cannedReply', idField: 'id', schema: cannedSchema, search: ['title'], orderBy: [{ title: 'asc' }], filters: [] },
  'notification-templates': { name: 'Notification template', delegate: 'notificationTemplate', idField: 'key', schema: templateSchema, search: ['key', 'titleEn'], orderBy: [{ key: 'asc' }], filters: [] },
};

/** Fields the client may set. Everything else in a stored row (ids, timestamps) is dropped before re-validation. */
const pick = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k] instanceof Date ? (row[k] as Date).toISOString() : row[k]]));

@Injectable()
export class ContentAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private d(e: EntityConfig) {
    return (this.prisma as unknown as Record<string, Delegate>)[e.delegate];
  }

  private isPublisher(a: Actor) {
    return a.admin.permissions.includes('content:publish');
  }

  private isLive(e: EntityConfig, row: Record<string, unknown>) {
    return !!e.publishVia && (e.publishVia.field === 'status' ? row.status === 'published' : row.published === true);
  }

  /** Where the item stands for students right now. */
  private state(e: EntityConfig, row: Record<string, unknown>, now: Date) {
    if (!e.publishVia) return undefined;
    if (e.publishVia.field === 'published') return row.published ? 'live' : 'draft';
    if (row.status !== 'published') return row.status as string;
    if (row.publishAt && (row.publishAt as Date) > now) return 'scheduled';
    if (row.expiresAt && (row.expiresAt as Date) <= now) return 'expired';
    return 'live';
  }

  async list(e: EntityConfig, q: Record<string, string | number | undefined> & { page: number; pageSize: number }) {
    const now = new Date();
    const where: Record<string, unknown> = {};
    for (const f of e.filters) if (q[f] !== undefined && q[f] !== '') where[f] = f === 'published' ? q[f] === 'true' : q[f];
    if (q.q) where.OR = e.search.map((f) => ({ [f]: { contains: String(q.q), mode: 'insensitive' } }));
    const [total, rows] = await Promise.all([this.d(e).count({ where }), this.d(e).findMany({ where, orderBy: [...e.orderBy, { [e.idField]: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize })]);
    return { page: q.page, pageSize: q.pageSize, total, items: rows.map((r) => ({ ...r, ...(e.publishVia ? { state: this.state(e, r, now) } : {}) })) };
  }

  async get(e: EntityConfig, id: string) {
    const row = await this.d(e).findUnique({ where: { [e.idField]: id } });
    if (!row) throw notFound(e.name);
    return { ...row, ...(e.publishVia ? { state: this.state(e, row, new Date()) } : {}) };
  }

  private parse(e: EntityConfig, input: unknown) {
    const r = e.schema.safeParse(input);
    if (!r.success) throw badRequest('VALIDATION_FAILED', 'Request validation failed', r.error.issues.map((i) => ({ field: i.path.join('.'), problems: [i.message] })));
    return r.data as Record<string, unknown>;
  }

  private async checkRefs(data: Record<string, unknown>) {
    const missing: string[] = [];
    const exists = async (model: 'exam' | 'subject' | 'topic', key: string, field: string, where: Record<string, unknown>) => {
      if (data[field] && !(await (this.prisma[model] as unknown as Delegate).findUnique({ where }))) missing.push(`${field}=${data[field]}`);
    };
    await exists('exam', 'id', 'examId', { id: data.examId });
    await exists('subject', 'code', 'subjectCode', { code: data.subjectCode });
    await exists('topic', 'code', 'topicCode', { code: data.topicCode });
    if (data.quizTestId && !(await this.prisma.test.findUnique({ where: { id: data.quizTestId as string } }))) missing.push(`quizTestId=${data.quizTestId}`);
    if (missing.length) throw badRequest('UNKNOWN_REFERENCE', `These do not exist: ${missing.join(', ')}`);
  }

  async create(a: Actor, e: EntityConfig, input: unknown) {
    const data = this.parse(e, input);
    await this.checkRefs(data);
    if (e.publishVia && this.wantsLive(e, data) && !this.isPublisher(a)) throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to do this', { required: 'content:publish' });
    try {
      const row = await this.d(e).create({ data });
      await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: `${e.delegate}.created`, targetType: e.delegate, target: String(row[e.idField]), after: { title: row.titleEn ?? row.title ?? row.key ?? row.id }, ip: a.ip });
      return row;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('ALREADY_EXISTS', `${e.name} already exists`);
      throw err;
    }
  }

  private wantsLive(e: EntityConfig, data: Record<string, unknown>) {
    return e.publishVia?.field === 'status' ? data.status === 'published' : data.published === true;
  }

  async update(a: Actor, e: EntityConfig, id: string, patch: Record<string, unknown>) {
    const row = await this.d(e).findUnique({ where: { [e.idField]: id } });
    if (!row) throw notFound(e.name);
    const keys = Object.keys((e.schema as unknown as { shape: object }).shape);
    const allowed = keys.length ? keys : Object.keys(row);
    const merged = this.parse(e, { ...pick(row, allowed), ...patch, ...(e.idField === 'key' || e.name === 'Note' ? { [e.idField]: id } : {}) });
    await this.checkRefs(merged);
    // Live content is changed by publishers only; a student-facing page must not change under an editor's hands.
    if (e.publishVia && !this.isPublisher(a) && (this.isLive(e, row) || this.wantsLive(e, merged))) throw new ApiError(403, 'FORBIDDEN', 'Only someone who can publish may change or publish live content', { required: 'content:publish' });
    if (e.idField !== 'id' || e.name === 'Note') delete merged[e.idField];
    const updated = await this.d(e).update({ where: { [e.idField]: id }, data: merged });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: `${e.delegate}.updated`, targetType: e.delegate, target: id, before: e.publishVia ? { live: this.isLive(e, row) } : undefined, after: e.publishVia ? { live: this.isLive(e, updated) } : undefined, meta: { fields: Object.keys(patch) }, ip: a.ip });
    return updated;
  }

  async remove(a: Actor, e: EntityConfig, id: string) {
    const row = await this.d(e).findUnique({ where: { [e.idField]: id } });
    if (!row) throw notFound(e.name);
    if (e.publishVia && this.isLive(e, row)) throw conflict('IS_LIVE', 'Unpublish or archive live content instead of deleting it');
    await this.d(e).delete({ where: { [e.idField]: id } });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: `${e.delegate}.deleted`, targetType: e.delegate, target: id, ip: a.ip });
  }

  /** draft / in_review / published / archived (or published true/false for notes). Publishing is for publishers. */
  async setStatus(a: Actor, e: EntityConfig, id: string, to: 'draft' | 'in_review' | 'published' | 'archived') {
    if (!e.publishVia) throw badRequest('NO_WORKFLOW', `${e.name} has no draft/publish workflow`);
    const row = await this.d(e).findUnique({ where: { [e.idField]: id } });
    if (!row) throw notFound(e.name);
    const goingLive = to === 'published';
    const leavingLive = this.isLive(e, row) && !goingLive;
    if ((goingLive || leavingLive) && !this.isPublisher(a)) throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to do this', { required: 'content:publish' });
    if (e.publishVia.field === 'published' && (to === 'in_review' || to === 'archived')) throw badRequest('NO_SUCH_STATE', 'Notes are either published or draft');
    const data = e.publishVia.field === 'status' ? { status: to } : { published: goingLive };
    const updated = await this.d(e).update({ where: { [e.idField]: id }, data });
    await this.audit.log({ actorType: 'admin', actor: a.admin.id, action: `${e.delegate}.${to}`, targetType: e.delegate, target: id, ip: a.ip });
    return { ...updated, state: this.state(e, updated, new Date()) };
  }
}

export const listQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), q: z.string().trim().min(2).max(80).optional() }).catchall(z.string().max(60));
