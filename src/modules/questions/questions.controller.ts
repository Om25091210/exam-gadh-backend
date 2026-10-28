import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { bool, zod } from '../../common/zod';
import { AdminRequest } from '../admin-auth/admin-auth.types';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { bulkTransitionInput, duplicateCheckInput, listQuery, questionInput, QuestionInput, reportListQuery, resolveReportInput, transitionInput } from './question-input';
import { QuestionsService } from './questions.service';

const actor = (r: AdminRequest) => ({ admin: r.admin, ip: r.ip });
const allowDup = z.object({ allowDuplicate: bool.default(false) });

@AdminController('questions')
export class QuestionsController {
  constructor(private readonly svc: QuestionsService) {}

  @Get()
  @RequirePermission('content:read')
  list(@Query(zod(listQuery)) q: z.infer<typeof listQuery>) {
    const { page, pageSize, ...filter } = q;
    return this.svc.list(filter, { page, pageSize });
  }

  @Get('duplicates')
  @RequirePermission('content:read')
  duplicates() {
    return this.svc.duplicates();
  }

  @Post('check-duplicate')
  @HttpCode(200)
  @RequirePermission('content:read')
  check(@Body(zod(duplicateCheckInput)) b: z.infer<typeof duplicateCheckInput>) {
    return this.svc.checkDuplicate(b.type, b.body);
  }

  @Post('bulk-status')
  @HttpCode(200)
  @RequirePermission('content:write')
  bulk(@Req() r: AdminRequest, @Body(zod(bulkTransitionInput)) b: z.infer<typeof bulkTransitionInput>) {
    return this.svc.bulkTransition(actor(r), b.ids, b.to);
  }

  @Get(':id')
  @RequirePermission('content:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }

  @Post()
  @RequirePermission('content:write')
  create(@Req() r: AdminRequest, @Body(zod(questionInput)) b: QuestionInput, @Query(zod(allowDup)) o: z.infer<typeof allowDup>) {
    return this.svc.create(actor(r), b, o.allowDuplicate);
  }

  @Put(':id')
  @RequirePermission('content:write')
  update(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(questionInput)) b: QuestionInput, @Query(zod(allowDup)) o: z.infer<typeof allowDup>) {
    return this.svc.update(actor(r), id, b, o.allowDuplicate);
  }

  /** Permission depends on the move (submit for review = content:write; publish/unpublish = content:publish); checked in the service. */
  @Post(':id/status')
  @HttpCode(200)
  @RequirePermission('content:write')
  transition(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(transitionInput)) b: z.infer<typeof transitionInput>) {
    return this.svc.transition(actor(r), id, b.to);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('content:write')
  remove(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(actor(r), id);
  }
}

@AdminController('question-reports')
export class QuestionReportsController {
  constructor(private readonly svc: QuestionsService) {}

  @Get()
  @RequirePermission('reports:read')
  list(@Query(zod(reportListQuery)) q: z.infer<typeof reportListQuery>) {
    return this.svc.reports(q.status, q);
  }

  @Patch(':id')
  @RequirePermission('reports:resolve')
  resolve(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(resolveReportInput)) b: z.infer<typeof resolveReportInput>) {
    return this.svc.resolveReport(actor(r), id, b.status, b.note);
  }
}

const passageBody = z.object({ en: z.string().trim().min(1).max(8000).optional(), hi: z.string().trim().min(1).max(8000).optional() }).refine((p) => p.en || p.hi, { message: 'provide the passage in at least one language' });

/** Passages can be shared by several questions (one passage, many questions). */
@AdminController('passages')
export class PassagesController {
  constructor(private readonly svc: QuestionsService) {}

  @Post()
  @RequirePermission('content:write')
  create(@Req() r: AdminRequest, @Body(zod(passageBody)) b: z.infer<typeof passageBody>) {
    return this.svc.createPassage(actor(r), b);
  }

  @Get(':id')
  @RequirePermission('content:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getPassage(id);
  }
}
