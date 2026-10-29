import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { zod } from '../../common/zod';
import { listQuery, NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query(zod(listQuery)) q: z.infer<typeof listQuery>) {
    return this.svc.list(u.id, q);
  }

  @Get('unread-count')
  unread(@CurrentUser() u: AuthUser) {
    return this.svc.unreadCount(u.id);
  }

  @Post('read-all')
  @HttpCode(200)
  readAll(@CurrentUser() u: AuthUser) {
    return this.svc.markAllRead(u.id);
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.svc.markRead(u.id, id);
  }
}
