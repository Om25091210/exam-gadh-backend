import { Body, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { badRequest } from '../../common/api-error';
import { bool, zod } from '../../common/zod';
import { AdminRequest } from '../admin-auth/admin-auth.types';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { listQuery } from '../questions/question-input';
import { ImportService } from './import.service';

const fmt = z.object({ format: z.enum(['csv', 'xlsx']).default('csv') });
const previewQuery = z.object({ allowDuplicates: bool.default(false) });
const commitBody = z.object({ skipInvalid: z.boolean().default(false) });
const exportQuery = listQuery.omit({ page: true, pageSize: true }).extend({ format: z.enum(['csv', 'xlsx']).default('csv') });

const send = (res: Response, f: { type: string; name: string; data: Buffer }) => {
  res.setHeader('Content-Type', f.type);
  res.setHeader('Content-Disposition', `attachment; filename="${f.name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(f.data);
};

@AdminController('import')
export class ImportController {
  constructor(private readonly svc: ImportService) {}

  @Get('questions/template')
  @RequirePermission('import:run')
  async template(@Query(zod(fmt)) q: z.infer<typeof fmt>, @Res() res: Response) {
    send(res, await this.svc.template(q.format));
  }

  @Post('questions/preview')
  @HttpCode(200)
  @RequirePermission('import:run')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  preview(@Req() r: AdminRequest, @UploadedFile() file: Express.Multer.File | undefined, @Query(zod(previewQuery)) q: z.infer<typeof previewQuery>) {
    if (!file) throw badRequest('FILE_REQUIRED', 'Attach a .csv or .xlsx file in the "file" field');
    return this.svc.preview({ admin: r.admin, ip: r.ip }, file, q.allowDuplicates);
  }

  @Post('jobs/:id/commit')
  @HttpCode(200)
  @RequirePermission('import:run')
  commit(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(commitBody)) b: z.infer<typeof commitBody>) {
    return this.svc.commit({ admin: r.admin, ip: r.ip }, id, b.skipInvalid);
  }

  @Get('jobs')
  @RequirePermission('import:run')
  jobs(@Req() r: AdminRequest) {
    return this.svc.jobs(r.admin.id);
  }

  @Get('jobs/:id')
  @RequirePermission('import:run')
  job(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.job(r.admin.id, id);
  }
}

@AdminController('export')
export class ExportController {
  constructor(private readonly svc: ImportService) {}

  @Get('questions')
  @RequirePermission('content:read')
  async questions(@Query(zod(exportQuery)) q: z.infer<typeof exportQuery>, @Res() res: Response) {
    const { format, ...filter } = q;
    send(res, await this.svc.exportQuestions(this.svc.where(filter), format));
  }
}
