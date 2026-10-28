import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../common/api-error';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AdminPrincipal } from '../admin-auth/admin-auth.types';
import { examPatch, examSchema, paperSchema, paperSubjects, subjectPatch, subjectSchema, subtopicPatch, subtopicSchema, topicPatch, topicSchema, verifySchema } from './taxonomy.schemas';

type Actor = { admin: AdminPrincipal; ip?: string };

const FK_IN_USE = 'P2003';
const NOT_FOUND = 'P2025';
const UNIQUE = 'P2002';

@Injectable()
export class TaxonomyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private log(a: Actor, action: string, targetType: string, target: string, before?: unknown, after?: unknown) {
    return this.audit.log({ actorType: 'admin', actor: a.admin.id, action, targetType, target, before, after, ip: a.ip });
  }

  /** Maps database errors to clear API errors. */
  private async guard<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === UNIQUE) throw conflict('ALREADY_EXISTS', `${what} already exists`);
        if (e.code === FK_IN_USE) throw conflict('IN_USE', `${what} is in use and cannot be removed or pointed at something that does not exist`);
        if (e.code === NOT_FOUND) throw notFound(what);
      }
      throw e;
    }
  }

  async tree() {
    const [exams, subjects] = await Promise.all([
      this.prisma.exam.findMany({ orderBy: { sort: 'asc' }, include: { papers: { orderBy: { sort: 'asc' }, include: { subjects: { orderBy: { sort: 'asc' } } } } } }),
      this.prisma.subject.findMany({ orderBy: { sort: 'asc' }, include: { topics: { orderBy: { sort: 'asc' }, include: { subtopics: { orderBy: { sort: 'asc' } } } } } }),
    ]);
    return { exams, subjects };
  }

  // ------------------------------------------------------------------ exams and papers (editable patterns)
  createExam(a: Actor, input: z.infer<typeof examSchema>) {
    return this.guard('Exam', async () => {
      const e = await this.prisma.exam.create({ data: { ...input, patternVerified: false } });
      await this.log(a, 'exam.created', 'exam', e.id, undefined, input);
      return e;
    });
  }

  async updateExam(a: Actor, id: string, patch: z.infer<typeof examPatch>) {
    const before = await this.prisma.exam.findUnique({ where: { id } });
    if (!before) throw notFound('Exam');
    const e = await this.prisma.exam.update({ where: { id }, data: patch });
    await this.log(a, 'exam.updated', 'exam', id, before, patch);
    return e;
  }

  async deleteExam(a: Actor, id: string) {
    const [tests, papers] = await Promise.all([this.prisma.test.count({ where: { examId: id } }), this.prisma.examPaper.count({ where: { examId: id } })]);
    if (tests || papers) throw conflict('IN_USE', `Exam has ${papers} paper(s) and ${tests} test(s); archive it instead`);
    await this.guard('Exam', () => this.prisma.exam.delete({ where: { id } }));
    await this.log(a, 'exam.deleted', 'exam', id);
  }

  /** Marks the pattern as checked against the official notification. Any later edit clears the flag again. */
  async verifyPattern(a: Actor, id: string, input: z.infer<typeof verifySchema>) {
    const exam = await this.prisma.exam.findUnique({ where: { id } });
    if (!exam) throw notFound('Exam');
    const e = await this.prisma.exam.update({ where: { id }, data: { patternVerified: true, patternSourceUrl: input.sourceUrl, patternNote: input.note ?? null } });
    await this.log(a, 'exam.pattern_verified', 'exam', id, { patternVerified: exam.patternVerified }, input);
    return e;
  }

  createPaper(a: Actor, examId: string, input: z.infer<typeof paperSchema>) {
    return this.guard('Paper', async () => {
      const id = `${examId}_${input.code.toLowerCase()}`;
      const paper = await this.prisma.$transaction(async (tx) => {
        const p = await tx.examPaper.create({ data: { ...input, id, examId } });
        await tx.exam.update({ where: { id: examId }, data: { patternVerified: false } });
        return p;
      });
      await this.log(a, 'paper.created', 'paper', id, undefined, input);
      return { paper, warnings: this.paperWarnings(input) };
    });
  }

  async updatePaper(a: Actor, id: string, input: z.infer<typeof paperSchema>) {
    const before = await this.prisma.examPaper.findUnique({ where: { id } });
    if (!before) throw notFound('Paper');
    const paper = await this.prisma.$transaction(async (tx) => {
      const p = await tx.examPaper.update({ where: { id }, data: input });
      await tx.exam.update({ where: { id: before.examId }, data: { patternVerified: false } }); // an edited pattern is unverified again
      return p;
    });
    await this.log(a, 'paper.updated', 'paper', id, before, input);
    return { paper, warnings: this.paperWarnings(input) };
  }

  async deletePaper(a: Actor, id: string) {
    if (await this.prisma.test.count({ where: { paperId: id } })) throw conflict('IN_USE', 'Tests use this paper; deactivate it instead');
    await this.guard('Paper', () => this.prisma.examPaper.delete({ where: { id } }));
    await this.log(a, 'paper.deleted', 'paper', id);
  }

  private paperWarnings(p: { questionCount: number; correctMarks: number; totalMarks: number }) {
    const expected = p.questionCount * p.correctMarks;
    return expected === p.totalMarks ? [] : [`total marks (${p.totalMarks}) differ from questions x marks (${expected}); check the pattern`];
  }

  async setPaperSubjects(a: Actor, paperId: string, input: z.infer<typeof paperSubjects>) {
    if (!(await this.prisma.examPaper.findUnique({ where: { id: paperId } }))) throw notFound('Paper');
    const known = await this.prisma.subject.count({ where: { code: { in: input.subjectCodes } } });
    if (known !== new Set(input.subjectCodes).size) throw badRequest('UNKNOWN_SUBJECT', 'Some subjects do not exist');
    await this.prisma.$transaction([
      this.prisma.paperSubject.deleteMany({ where: { paperId } }),
      this.prisma.paperSubject.createMany({ data: input.subjectCodes.map((subjectCode, sort) => ({ paperId, subjectCode, sort })) }),
    ]);
    await this.log(a, 'paper.subjects_set', 'paper', paperId, undefined, input);
  }

  // ------------------------------------------------------------------ subject / topic / subtopic
  createSubject(a: Actor, input: z.infer<typeof subjectSchema>) {
    return this.guard('Subject', async () => {
      const s = await this.prisma.subject.create({ data: input });
      await this.log(a, 'subject.created', 'subject', s.code, undefined, input);
      return s;
    });
  }
  updateSubject(a: Actor, code: string, patch: z.infer<typeof subjectPatch>) {
    return this.guard('Subject', async () => {
      const s = await this.prisma.subject.update({ where: { code }, data: patch });
      await this.log(a, 'subject.updated', 'subject', code, undefined, patch);
      return s;
    });
  }
  async deleteSubject(a: Actor, code: string) {
    await this.guard('Subject', () => this.prisma.subject.delete({ where: { code } }));
    await this.log(a, 'subject.deleted', 'subject', code);
  }

  createTopic(a: Actor, input: z.infer<typeof topicSchema>) {
    return this.guard('Topic', async () => {
      const t = await this.prisma.topic.create({ data: input });
      await this.log(a, 'topic.created', 'topic', t.code, undefined, input);
      return t;
    });
  }
  updateTopic(a: Actor, code: string, patch: z.infer<typeof topicPatch>) {
    return this.guard('Topic', async () => {
      const t = await this.prisma.topic.update({ where: { code }, data: patch });
      await this.log(a, 'topic.updated', 'topic', code, undefined, patch);
      return t;
    });
  }
  async deleteTopic(a: Actor, code: string) {
    if (await this.prisma.question.count({ where: { topicCode: code } })) throw conflict('IN_USE', 'Questions use this topic; move them first');
    await this.guard('Topic', () => this.prisma.topic.delete({ where: { code } }));
    await this.log(a, 'topic.deleted', 'topic', code);
  }

  createSubtopic(a: Actor, input: z.infer<typeof subtopicSchema>) {
    return this.guard('Subtopic', async () => {
      const t = await this.prisma.subtopic.create({ data: input });
      await this.log(a, 'subtopic.created', 'subtopic', t.code, undefined, input);
      return t;
    });
  }
  updateSubtopic(a: Actor, code: string, patch: z.infer<typeof subtopicPatch>) {
    return this.guard('Subtopic', async () => {
      const t = await this.prisma.subtopic.update({ where: { code }, data: patch });
      await this.log(a, 'subtopic.updated', 'subtopic', code, undefined, patch);
      return t;
    });
  }
  async deleteSubtopic(a: Actor, code: string) {
    if (await this.prisma.question.count({ where: { subtopicCode: code } })) throw conflict('IN_USE', 'Questions use this subtopic; move them first');
    await this.guard('Subtopic', () => this.prisma.subtopic.delete({ where: { code } }));
    await this.log(a, 'subtopic.deleted', 'subtopic', code);
  }
}

