import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { zod } from '../../common/zod';
import { AdminRequest } from '../admin-auth/admin-auth.types';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { RegradeService } from './regrade.service';
import { SeriesService } from './series.service';
import { analyticsQuery, createTest, keyCorrection, listTests, patchTest, pickInput, questionsInput, sectionsInput, seriesInput, seriesItems, seriesPatch, versionConfig } from './tests-admin.schemas';
import { TestsAdminService } from './tests-admin.service';
import { TestsAnalyticsService } from './tests-analytics.service';

const actor = (r: AdminRequest) => ({ admin: r.admin, ip: r.ip });
@AdminController('tests')
export class TestsAdminController {
  constructor(
    private readonly svc: TestsAdminService,
    private readonly analytics: TestsAnalyticsService,
    private readonly regrade: RegradeService,
  ) {}

  @Get()
  @RequirePermission('content:read')
  list(@Query(zod(listTests)) q: z.infer<typeof listTests>) {
    return this.svc.list(q);
  }

  @Post()
  @RequirePermission('test:write')
  create(@Req() r: AdminRequest, @Body(zod(createTest)) b: z.infer<typeof createTest>) {
    return this.svc.create(actor(r), b);
  }

  @Get(':id')
  @RequirePermission('content:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }

  @Patch(':id')
  @RequirePermission('test:write')
  patch(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(patchTest)) b: z.infer<typeof patchTest>) {
    return this.svc.patch(actor(r), id, b);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('test:write')
  remove(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(actor(r), id);
  }

  @Post(':id/archive')
  @HttpCode(204)
  @RequirePermission('test:publish')
  archive(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.setArchived(actor(r), id, true);
  }

  @Post(':id/unarchive')
  @HttpCode(204)
  @RequirePermission('test:publish')
  unarchive(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.setArchived(actor(r), id, false);
  }

  // ---- versions
  @Post(':id/versions')
  @RequirePermission('test:write')
  newDraft(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.newDraft(actor(r), id);
  }

  @Get(':id/versions/:vid')
  @RequirePermission('content:read')
  version(@Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string) {
    return this.svc.version(id, vid);
  }

  @Put(':id/versions/:vid')
  @RequirePermission('test:write')
  config(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string, @Body(zod(versionConfig)) b: z.infer<typeof versionConfig>) {
    return this.svc.updateConfig(actor(r), id, vid, b);
  }

  @Delete(':id/versions/:vid')
  @HttpCode(204)
  @RequirePermission('test:write')
  discard(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string) {
    return this.svc.discardDraft(actor(r), id, vid);
  }

  @Put(':id/versions/:vid/sections')
  @RequirePermission('test:write')
  sections(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string, @Body(zod(sectionsInput)) b: z.infer<typeof sectionsInput>) {
    return this.svc.setSections(actor(r), id, vid, b);
  }

  @Put(':id/versions/:vid/questions')
  @RequirePermission('test:write')
  questions(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string, @Body(zod(questionsInput)) b: z.infer<typeof questionsInput>) {
    return this.svc.setQuestions(actor(r), id, vid, b);
  }

  @Post(':id/versions/:vid/pick')
  @HttpCode(200)
  @RequirePermission('test:write')
  pick(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string, @Body(zod(pickInput)) b: z.infer<typeof pickInput>) {
    return this.svc.pick(actor(r), id, vid, b);
  }

  @Post(':id/versions/:vid/publish')
  @HttpCode(200)
  @RequirePermission('test:publish')
  publish(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string) {
    return this.svc.publish(actor(r), id, vid);
  }

  @Post(':id/versions/:vid/correct-key')
  @HttpCode(200)
  @RequirePermission('test:publish')
  correctKey(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Param('vid', ParseUUIDPipe) vid: string, @Body(zod(keyCorrection)) b: z.infer<typeof keyCorrection>) {
    return this.regrade.correctKey(actor(r), id, vid, b);
  }

  // ---- results
  @Get(':id/analytics')
  @RequirePermission('results:read')
  stats(@Param('id', ParseUUIDPipe) id: string, @Query(zod(analyticsQuery)) q: z.infer<typeof analyticsQuery>) {
    return this.analytics.analytics(id, q.versionId);
  }

  @Get(':id/results.csv')
  @RequirePermission('results:read')
  async csv(@Param('id', ParseUUIDPipe) id: string, @Query(zod(analyticsQuery)) q: z.infer<typeof analyticsQuery>, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="results.csv"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(await this.analytics.resultsCsv(id, q.versionId));
  }
}

@AdminController('series')
export class SeriesController {
  constructor(private readonly svc: SeriesService) {}

  @Get()
  @RequirePermission('content:read')
  list() {
    return this.svc.list();
  }

  @Post()
  @RequirePermission('series:write')
  create(@Req() r: AdminRequest, @Body(zod(seriesInput)) b: z.infer<typeof seriesInput>) {
    return this.svc.create(actor(r), b);
  }

  @Get(':id')
  @RequirePermission('content:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }

  @Patch(':id')
  @RequirePermission('series:write')
  patch(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(seriesPatch)) b: z.infer<typeof seriesPatch>) {
    return this.svc.patch(actor(r), id, b);
  }

  @Put(':id/items')
  @HttpCode(204)
  @RequirePermission('series:write')
  items(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(seriesItems)) b: z.infer<typeof seriesItems>) {
    return this.svc.setItems(actor(r), id, b);
  }
}
