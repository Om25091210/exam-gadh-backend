import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { zod } from '../../common/zod';
import { AdminRequest } from '../admin-auth/admin-auth.types';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { abuseBody, adminDoubtsQuery, createDoubt, DoubtsService, followUp, myDoubtsQuery, rateDoubt, similarQuery, staffReply, statsQuery, uploadBody } from './doubts.service';

@ApiTags('doubts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('doubts')
export class DoubtsController {
  constructor(private readonly svc: DoubtsService) {}

  @Get('quota')
  quota(@CurrentUser() u: AuthUser) {
    return this.svc.quota(u.id);
  }

  @Get('similar')
  similar(@Query(zod(similarQuery)) q: z.infer<typeof similarQuery>) {
    return this.svc.similar(q);
  }

  @Post('uploads/presign')
  @HttpCode(200)
  presign(@CurrentUser() u: AuthUser, @Body(zod(uploadBody)) b: z.infer<typeof uploadBody>) {
    return this.svc.presignUpload(u.id, b);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body(zod(createDoubt)) b: z.infer<typeof createDoubt>) {
    return this.svc.create(u.id, b);
  }

  @Get()
  list(@CurrentUser() u: AuthUser, @Query(zod(myDoubtsQuery)) q: z.infer<typeof myDoubtsQuery>) {
    return this.svc.list(u.id, q);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(u.id, id);
  }

  @Post(':id/messages')
  reply(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(zod(followUp)) b: z.infer<typeof followUp>) {
    return this.svc.reply(u.id, id, b);
  }

  @Post(':id/rating')
  @HttpCode(204)
  rate(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(zod(rateDoubt)) b: z.infer<typeof rateDoubt>) {
    return this.svc.rate(u.id, id, b.rating);
  }

  @Post(':id/close')
  @HttpCode(204)
  close(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.closeMine(u.id, id);
  }
}

const actor = (r: AdminRequest) => ({ id: r.admin.id, ip: r.ip });

@AdminController('doubts')
export class AdminDoubtsController {
  constructor(private readonly svc: DoubtsService) {}

  @Get()
  @RequirePermission('doubts:read')
  list(@Query(zod(adminDoubtsQuery)) q: z.infer<typeof adminDoubtsQuery>) {
    return this.svc.adminList(q);
  }

  @Get('stats')
  @RequirePermission('doubts:read')
  stats(@Query(zod(statsQuery)) q: z.infer<typeof statsQuery>) {
    return this.svc.stats(q.days);
  }

  @Get(':id')
  @RequirePermission('doubts:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.adminGet(id);
  }

  @Post(':id/reply')
  @HttpCode(204)
  @RequirePermission('doubts:answer')
  reply(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(staffReply)) b: z.infer<typeof staffReply>) {
    return this.svc.adminReply(actor(r), id, b);
  }

  @Post(':id/close')
  @HttpCode(204)
  @RequirePermission('doubts:answer')
  close(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.adminClose(actor(r), id);
  }

  @Post(':id/abuse')
  @HttpCode(204)
  @RequirePermission('doubts:answer')
  abuse(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(abuseBody)) b: z.infer<typeof abuseBody>) {
    return this.svc.setAbuse(actor(r), id, b.abuse);
  }
}
