import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { zod } from '../../common/zod';
import { AdminRequest } from '../admin-auth/admin-auth.types';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { adminListQuery, MentorService, requestBody } from './mentor.service';

@ApiTags('mentor')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('mentor')
export class MentorController {
  constructor(private readonly svc: MentorService) {}

  @Get()
  mine(@CurrentUser() u: AuthUser) {
    return this.svc.mine(u.id);
  }

  @Get('today')
  today(@CurrentUser() u: AuthUser) {
    return this.svc.today(u.id);
  }

  @Post('requests')
  request(@CurrentUser() u: AuthUser, @Body(zod(requestBody)) b: z.infer<typeof requestBody>) {
    return this.svc.request(u.id, b);
  }
}

const actor = (r: AdminRequest) => ({ id: r.admin.id, ip: r.ip });

@AdminController('mentor')
export class AdminMentorController {
  constructor(private readonly svc: MentorService) {}

  @Get('requests')
  @RequirePermission('mentor:manage')
  list(@Query(zod(adminListQuery)) q: z.infer<typeof adminListQuery>) {
    return this.svc.adminList(q);
  }

  @Get('requests/:id')
  @RequirePermission('mentor:manage')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.adminGet(id);
  }

  @Put('requests/:id/plan')
  @HttpCode(204)
  @RequirePermission('mentor:manage')
  save(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.svc.savePlan(actor(r), id, body);
  }

  @Post('requests/:id/regenerate')
  @HttpCode(200)
  @RequirePermission('mentor:manage')
  regenerate(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.regenerate(actor(r), id);
  }

  @Post('requests/:id/send')
  @HttpCode(204)
  @RequirePermission('mentor:manage')
  send(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.send(actor(r), id);
  }
}
