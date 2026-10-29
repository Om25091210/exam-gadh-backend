import { Body, Controller, Delete, Req, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { zod } from '../../common/zod';
import { Throttle } from '@nestjs/throttler';
import { AccountService } from './account.service';
import { AnalyticsService } from './analytics.service';
import { HomeService } from './home.service';
import { bookmarkBody, MeService, noteBody, periodQuery, practiceBody, reportBody, revisionQuery } from './me.service';

const deleteBody = z.object({ confirm: z.literal('DELETE') });
const analyticsQuery = z.object({ days: z.coerce.number().int().min(7).max(365).default(90) });
const bookmarkKind = z.object({ kind: z.enum(['question', 'material', 'current_affair']).optional() });
const bookmarkParams = z.object({ kind: z.enum(['question', 'material', 'current_affair']), refId: z.string().uuid() });

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class MeController {
  constructor(
    private readonly home: HomeService,
    private readonly analytics: AnalyticsService,
    private readonly me: MeService,
    private readonly account: AccountService,
  ) {}

  @Get('home')
  homeScreen(@CurrentUser() u: AuthUser) {
    return this.home.home(u.id);
  }

  @Get('me/analytics')
  getAnalytics(@CurrentUser() u: AuthUser, @Query(zod(analyticsQuery)) q: z.infer<typeof analyticsQuery>) {
    return this.analytics.analytics(u.id, q.days);
  }

  @Get('me/bookmarks')
  bookmarks(@CurrentUser() u: AuthUser, @Query(zod(bookmarkKind)) q: z.infer<typeof bookmarkKind>) {
    return this.me.bookmarks(u.id, q.kind);
  }

  @Post('me/bookmarks')
  addBookmark(@CurrentUser() u: AuthUser, @Body(zod(bookmarkBody)) b: z.infer<typeof bookmarkBody>) {
    return this.me.addBookmark(u.id, b);
  }

  @Delete('me/bookmarks/:kind/:refId')
  @HttpCode(204)
  async removeBookmark(@CurrentUser() u: AuthUser, @Param(zod(bookmarkParams)) p: z.infer<typeof bookmarkParams>) {
    await this.me.removeBookmark(u.id, p.kind, p.refId);
  }

  @Get('me/notes')
  notes(@CurrentUser() u: AuthUser) {
    return this.me.notes(u.id);
  }

  @Put('me/notes')
  saveNote(@CurrentUser() u: AuthUser, @Body(zod(noteBody)) b: z.infer<typeof noteBody>) {
    return this.me.saveNote(u.id, b);
  }

  @Delete('me/notes/:questionId')
  @HttpCode(204)
  async deleteNote(@CurrentUser() u: AuthUser, @Param('questionId', ParseUUIDPipe) id: string) {
    await this.me.deleteNote(u.id, id);
  }

  @Post('me/question-reports')
  report(@CurrentUser() u: AuthUser, @Body(zod(reportBody)) b: z.infer<typeof reportBody>) {
    return this.me.report(u.id, b);
  }

  @Get('me/revision')
  revision(@CurrentUser() u: AuthUser, @Query(zod(revisionQuery)) q: z.infer<typeof revisionQuery>) {
    return this.me.revision(u.id, q);
  }

  @Post('practice')
  practice(@CurrentUser() u: AuthUser, @Body(zod(practiceBody)) b: z.infer<typeof practiceBody>) {
    return this.me.createPractice(u.id, b);
  }

  @Get('leaderboard')
  leaderboard(@CurrentUser() u: AuthUser, @Query(zod(periodQuery)) q: z.infer<typeof periodQuery>) {
    return this.me.overallLeaderboard(u.id, q);
  }

  @Get('me/orders')
  orders(@CurrentUser() u: AuthUser) {
    return this.me.orders(u.id);
  }

  @Get('me/orders/:id/receipt')
  receipt(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.me.receipt(u.id, id);
  }

  @Get('me/export')
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  exportData(@CurrentUser() u: AuthUser) {
    return this.account.export(u.id);
  }

  @Delete('me')
  @HttpCode(204)
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  async deleteAccount(@CurrentUser() u: AuthUser, @Body(zod(deleteBody)) _b: z.infer<typeof deleteBody>, @Req() req: { ip?: string }) {
    await this.account.delete(u.id, req.ip);
  }
}
