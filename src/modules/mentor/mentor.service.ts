import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { Clock } from '../../common/clock';
import { istDateString } from '../../common/ist';
import { sanitizeRichText } from '../../common/rich-text';
import { pageQuery, skipTake } from '../../common/zod';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { buildStudyPlan, StudyPlan, studyPlanSchema } from './study-plan';

export const requestBody = z.object({
  examId: z.string().min(1).max(40),
  hoursPerDay: z.number().min(0.5).max(16),
  examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export const adminListQuery = z.object({ ...pageQuery, status: z.enum(['open', 'sent']).optional() });

/** Plain-text fields only: strip markup from everything a mentor typed. */
const clean = <T>(v: T): T => {
  if (typeof v === 'string') return sanitizeRichText(v) as T;
  if (Array.isArray(v)) return v.map(clean) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) as T;
  return v;
};

@Injectable()
export class MentorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /** Topics of the exam's papers (via the paper-subject links); falls back to the whole syllabus. */
  private async examTopics(examId: string, userId: string) {
    const links = await this.prisma.paperSubject.findMany({ where: { paper: { examId, active: true } }, select: { subjectCode: true } });
    const subjectCodes = [...new Set(links.map((l) => l.subjectCode))];
    const topics = await this.prisma.topic.findMany({ where: subjectCodes.length ? { subjectCode: { in: subjectCodes } } : {}, orderBy: [{ subjectCode: 'asc' }, { sort: 'asc' }] });
    const stats = new Map((await this.prisma.userTopicStat.findMany({ where: { userId } })).map((s) => [s.topicCode, s]));
    return topics.map((t) => {
      const s = stats.get(t.code);
      return { code: t.code, nameEn: t.nameEn, nameHi: t.nameHi, weight: t.weight, accuracyPct: s && s.attempted >= 5 ? Math.round((s.correct / s.attempted) * 100) : null };
    });
  }

  private async draft(userId: string, examId: string, hoursPerDay: number, examDate?: string | null): Promise<StudyPlan> {
    const now = this.clock.now();
    return buildStudyPlan({ today: istDateString(now), examDate, hoursPerDay, topics: await this.examTopics(examId, userId) }, now, examId);
  }

  // ------------------------------------------------------------------ student
  async request(userId: string, b: z.infer<typeof requestBody>) {
    if (!(await this.prisma.exam.findFirst({ where: { id: b.examId, active: true } }))) throw badRequest('UNKNOWN_EXAM', 'Unknown exam');
    const today = istDateString(this.clock.now());
    if (b.examDate) {
      const max = new Date(this.clock.now().getTime() + 730 * 86_400_000).toISOString().slice(0, 10);
      if (Number.isNaN(Date.parse(b.examDate)) || b.examDate <= today || b.examDate > max) throw badRequest('INVALID_EXAM_DATE', 'Exam date must be in the future, within two years');
    }
    if (await this.prisma.mentorRequest.findFirst({ where: { userId, status: 'open' } })) throw conflict('MENTOR_REQUEST_OPEN', 'Your previous request is still with your mentor. You will be notified when the plan is ready.');
    const plan = await this.draft(userId, b.examId, b.hoursPerDay, b.examDate);
    const r = await this.prisma.mentorRequest.create({ data: { userId, examId: b.examId, hoursPerDay: b.hoursPerDay, examDate: b.examDate ? new Date(`${b.examDate}T00:00:00Z`) : null, plan: plan as never, createdAt: this.clock.now() } });
    return this.studentView(r);
  }

  private studentView(r: { id: string; examId: string; hoursPerDay: number; examDate: Date | null; status: string; plan: unknown; sentAt: Date | null; createdAt: Date }) {
    return {
      id: r.id, examId: r.examId, hoursPerDay: r.hoursPerDay, examDate: r.examDate ? istDateString(r.examDate) : null, status: r.status, createdAt: r.createdAt, sentAt: r.sentAt,
      // a draft stays with the mentor until they send it
      plan: r.status === 'sent' ? r.plan : null,
    };
  }

  async mine(userId: string) {
    const rows = await this.prisma.mentorRequest.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10 });
    return { requests: rows.map((r) => this.studentView(r)) };
  }

  /** Today's tasks from the latest plan the mentor sent. */
  async today(userId: string) {
    const r = await this.prisma.mentorRequest.findFirst({ where: { userId, status: 'sent' }, orderBy: { sentAt: 'desc' } });
    if (!r) return { plan: null, date: istDateString(this.clock.now()), day: null };
    const date = istDateString(this.clock.now());
    const plan = r.plan as unknown as StudyPlan;
    const day = plan.weeks.flatMap((w) => w.days).find((d) => d.date === date) ?? null;
    return { plan: { requestId: r.id, startDate: plan.startDate, endDate: plan.endDate }, date, day };
  }

  // ------------------------------------------------------------------ mentor / teacher
  async adminList(q: z.infer<typeof adminListQuery>) {
    const where = { status: q.status };
    const [rows, total] = await Promise.all([
      this.prisma.mentorRequest.findMany({ where, orderBy: { createdAt: q.status === 'sent' ? 'desc' : 'asc' }, ...skipTake(q) }),
      this.prisma.mentorRequest.count({ where }),
    ]);
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]));
    return { total, page: q.page, pageSize: q.pageSize, items: rows.map((r) => ({ id: r.id, status: r.status, student: users.get(r.userId) ?? null, examId: r.examId, hoursPerDay: r.hoursPerDay, examDate: r.examDate ? istDateString(r.examDate) : null, createdAt: r.createdAt, sentAt: r.sentAt })) };
  }

  async adminGet(id: string) {
    const r = await this.prisma.mentorRequest.findUnique({ where: { id } });
    if (!r) throw notFound('Mentor request');
    const [user, stats] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: r.userId }, select: { id: true, name: true, email: true, district: true } }),
      this.examTopics(r.examId, r.userId),
    ]);
    return { id: r.id, status: r.status, examId: r.examId, hoursPerDay: r.hoursPerDay, examDate: r.examDate ? istDateString(r.examDate) : null, createdAt: r.createdAt, sentAt: r.sentAt, student: user, plan: r.plan, topicAccuracy: stats.map((t) => ({ topicCode: t.code, nameEn: t.nameEn, accuracyPct: t.accuracyPct })) };
  }

  private async openRequest(id: string) {
    const r = await this.prisma.mentorRequest.findUnique({ where: { id } });
    if (!r) throw notFound('Mentor request');
    if (r.status === 'sent') throw conflict('PLAN_ALREADY_SENT', 'This plan was already sent. The student can request a new one.');
    return r;
  }

  async savePlan(admin: { id: string; ip?: string }, id: string, plan: unknown) {
    await this.openRequest(id);
    const parsed = studyPlanSchema.safeParse(plan);
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Plan is not valid', parsed.error.issues.map((i) => ({ field: i.path.join('.'), problems: [i.message] })));
    await this.prisma.mentorRequest.update({ where: { id }, data: { plan: clean(parsed.data) as never } });
    await this.audit.log({ actorType: 'admin', actor: admin.id, action: 'mentor.edit-plan', target: id, targetType: 'mentor_request', ip: admin.ip });
  }

  async regenerate(admin: { id: string; ip?: string }, id: string) {
    const r = await this.openRequest(id);
    const plan = await this.draft(r.userId, r.examId, r.hoursPerDay, r.examDate ? istDateString(r.examDate) : null);
    await this.prisma.mentorRequest.update({ where: { id }, data: { plan: plan as never } });
    await this.audit.log({ actorType: 'admin', actor: admin.id, action: 'mentor.regenerate-plan', target: id, targetType: 'mentor_request', ip: admin.ip });
    return plan;
  }

  async send(admin: { id: string; ip?: string }, id: string) {
    const r = await this.openRequest(id);
    const plan = studyPlanSchema.safeParse(r.plan);
    if (!plan.success) throw badRequest('PLAN_INVALID', 'Fix the plan before sending it');
    const now = this.clock.now();
    const res = await this.prisma.mentorRequest.updateMany({ where: { id, status: 'open' }, data: { status: 'sent', sentAt: now } });
    if (res.count === 0) throw conflict('PLAN_ALREADY_SENT', 'This plan was already sent');
    await this.notifications.notify({ userId: r.userId, kind: 'study_plan_ready', vars: { date: plan.data.endDate }, dedupeKey: `plan:${id}`, data: { requestId: id } });
    await this.audit.log({ actorType: 'admin', actor: admin.id, action: 'mentor.send-plan', target: id, targetType: 'mentor_request', ip: admin.ip });
  }
}
