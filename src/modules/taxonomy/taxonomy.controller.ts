import { Body, Delete, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { zod } from '../../common/zod';
import { AdminRequest } from '../admin-auth/admin-auth.types';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { examPatch, examSchema, paperSchema, paperSubjects, subjectPatch, subjectSchema, subtopicPatch, subtopicSchema, topicPatch, topicSchema, verifySchema } from './taxonomy.schemas';
import { TaxonomyService } from './taxonomy.service';

const actor = (req: AdminRequest) => ({ admin: req.admin, ip: req.ip });

@AdminController('taxonomy')
export class TaxonomyController {
  constructor(private readonly svc: TaxonomyService) {}

  @Get('tree')
  @RequirePermission('content:read')
  tree() {
    return this.svc.tree();
  }

  // exams and patterns
  @Post('exams')
  @RequirePermission('exam-config:write')
  createExam(@Req() r: AdminRequest, @Body(zod(examSchema)) b: ReturnType<typeof examSchema.parse>) {
    return this.svc.createExam(actor(r), b);
  }
  @Patch('exams/:id')
  @RequirePermission('exam-config:write')
  updateExam(@Req() r: AdminRequest, @Param('id') id: string, @Body(zod(examPatch)) b: ReturnType<typeof examPatch.parse>) {
    return this.svc.updateExam(actor(r), id, b);
  }
  @Delete('exams/:id')
  @HttpCode(204)
  @RequirePermission('exam-config:write')
  deleteExam(@Req() r: AdminRequest, @Param('id') id: string) {
    return this.svc.deleteExam(actor(r), id);
  }
  @Post('exams/:id/verify-pattern')
  @HttpCode(200)
  @RequirePermission('exam-config:write')
  verify(@Req() r: AdminRequest, @Param('id') id: string, @Body(zod(verifySchema)) b: ReturnType<typeof verifySchema.parse>) {
    return this.svc.verifyPattern(actor(r), id, b);
  }
  @Post('exams/:examId/papers')
  @RequirePermission('exam-config:write')
  createPaper(@Req() r: AdminRequest, @Param('examId') examId: string, @Body(zod(paperSchema)) b: ReturnType<typeof paperSchema.parse>) {
    return this.svc.createPaper(actor(r), examId, b);
  }
  @Put('papers/:id')
  @RequirePermission('exam-config:write')
  updatePaper(@Req() r: AdminRequest, @Param('id') id: string, @Body(zod(paperSchema)) b: ReturnType<typeof paperSchema.parse>) {
    return this.svc.updatePaper(actor(r), id, b);
  }
  @Delete('papers/:id')
  @HttpCode(204)
  @RequirePermission('exam-config:write')
  deletePaper(@Req() r: AdminRequest, @Param('id') id: string) {
    return this.svc.deletePaper(actor(r), id);
  }
  @Put('papers/:id/subjects')
  @HttpCode(204)
  @RequirePermission('exam-config:write')
  paperSubjects(@Req() r: AdminRequest, @Param('id') id: string, @Body(zod(paperSubjects)) b: ReturnType<typeof paperSubjects.parse>) {
    return this.svc.setPaperSubjects(actor(r), id, b);
  }

  // subjects, topics, subtopics
  @Post('subjects')
  @RequirePermission('taxonomy:write')
  createSubject(@Req() r: AdminRequest, @Body(zod(subjectSchema)) b: ReturnType<typeof subjectSchema.parse>) {
    return this.svc.createSubject(actor(r), b);
  }
  @Patch('subjects/:code')
  @RequirePermission('taxonomy:write')
  updateSubject(@Req() r: AdminRequest, @Param('code') c: string, @Body(zod(subjectPatch)) b: ReturnType<typeof subjectPatch.parse>) {
    return this.svc.updateSubject(actor(r), c, b);
  }
  @Delete('subjects/:code')
  @HttpCode(204)
  @RequirePermission('taxonomy:write')
  deleteSubject(@Req() r: AdminRequest, @Param('code') c: string) {
    return this.svc.deleteSubject(actor(r), c);
  }
  @Post('topics')
  @RequirePermission('taxonomy:write')
  createTopic(@Req() r: AdminRequest, @Body(zod(topicSchema)) b: ReturnType<typeof topicSchema.parse>) {
    return this.svc.createTopic(actor(r), b);
  }
  @Patch('topics/:code')
  @RequirePermission('taxonomy:write')
  updateTopic(@Req() r: AdminRequest, @Param('code') c: string, @Body(zod(topicPatch)) b: ReturnType<typeof topicPatch.parse>) {
    return this.svc.updateTopic(actor(r), c, b);
  }
  @Delete('topics/:code')
  @HttpCode(204)
  @RequirePermission('taxonomy:write')
  deleteTopic(@Req() r: AdminRequest, @Param('code') c: string) {
    return this.svc.deleteTopic(actor(r), c);
  }
  @Post('subtopics')
  @RequirePermission('taxonomy:write')
  createSubtopic(@Req() r: AdminRequest, @Body(zod(subtopicSchema)) b: ReturnType<typeof subtopicSchema.parse>) {
    return this.svc.createSubtopic(actor(r), b);
  }
  @Patch('subtopics/:code')
  @RequirePermission('taxonomy:write')
  updateSubtopic(@Req() r: AdminRequest, @Param('code') c: string, @Body(zod(subtopicPatch)) b: ReturnType<typeof subtopicPatch.parse>) {
    return this.svc.updateSubtopic(actor(r), c, b);
  }
  @Delete('subtopics/:code')
  @HttpCode(204)
  @RequirePermission('taxonomy:write')
  deleteSubtopic(@Req() r: AdminRequest, @Param('code') c: string) {
    return this.svc.deleteSubtopic(actor(r), c);
  }
}
