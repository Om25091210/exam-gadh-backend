import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { badRequest, notFound } from '../../common/api-error';
import { istDateString } from '../../common/ist';
import { zod } from '../../common/zod';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { caQuery, materialQuery, monthQuery, pyqQuery, StudentContentService } from './student-content.service';

const examOnly = z.object({ examId: z.string().max(40).optional() });
const faqQuery = z.object({ q: z.string().trim().min(2).max(80).optional() });
const interviewQuery = z.object({ examId: z.string().max(40).optional(), category: z.string().max(40).optional() });

@ApiTags('learn')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class StudentContentController {
  constructor(private readonly svc: StudentContentService) {}

  @Get('ca')
  ca(@CurrentUser() u: AuthUser, @Query(zod(caQuery)) q: z.infer<typeof caQuery>) {
    return this.svc.ca(u.id, q);
  }

  @Get('ca/monthly')
  caMonth(@CurrentUser() u: AuthUser, @Query(zod(monthQuery)) q: z.infer<typeof monthQuery>) {
    return this.svc.caMonth(u.id, q.month);
  }

  @Get('ca/:id')
  caItem(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.caItem(u.id, id);
  }

  @Get('updates')
  updates(@Query(zod(examOnly)) q: z.infer<typeof examOnly>) {
    return this.svc.updates(q.examId);
  }

  @Get('faqs')
  faqs(@Query(zod(faqQuery)) q: z.infer<typeof faqQuery>) {
    return this.svc.faqs(q.q);
  }

  @Get('interview')
  interview(@Query(zod(interviewQuery)) q: z.infer<typeof interviewQuery>) {
    return this.svc.interview(q.examId, q.category);
  }

  @Get('materials')
  materials(@CurrentUser() u: AuthUser, @Query(zod(materialQuery)) q: z.infer<typeof materialQuery>) {
    return this.svc.materials(u.id, q);
  }

  @Get('materials/:id')
  material(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.material(u.id, id);
  }

  @Get('pyq')
  pyq(@CurrentUser() u: AuthUser, @Query(zod(pyqQuery)) q: z.infer<typeof pyqQuery>) {
    return this.svc.pyq(u.id, q);
  }

  @Get('pyq/frequency')
  pyqFrequency(@Query(zod(examOnly)) q: z.infer<typeof examOnly>) {
    return this.svc.pyqFrequency(q.examId);
  }

  @Get('series')
  series(@CurrentUser() u: AuthUser, @Query(zod(examOnly)) q: z.infer<typeof examOnly>) {
    return this.svc.seriesList(u.id, q.examId);
  }

  @Get('series/:id')
  seriesDetail(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.seriesDetail(u.id, id);
  }

  @Post('series/:id/enroll')
  enroll(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.enroll(u.id, id);
  }

  @Delete('series/:id/enroll')
  @HttpCode(204)
  unenroll(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.unenroll(u.id, id);
  }

  @Get('daily-quiz')
  dailyQuiz(@CurrentUser() u: AuthUser) {
    return this.svc.dailyQuiz(u.id);
  }
}

const dailyBody = z.object({ testId: z.string().uuid() });

@AdminController('daily-quiz')
export class AdminDailyQuizController {
  constructor(private readonly prisma: PrismaService) {}

  /** Choose which published test is the quiz for a given (IST) day. */
  @Put(':date')
  @RequirePermission('content:write')
  async set(@Param('date') date: string, @Body(zod(dailyBody)) b: z.infer<typeof dailyBody>) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw badRequest('INVALID_DATE', 'Use YYYY-MM-DD');
    const t = await this.prisma.test.findFirst({ where: { id: b.testId, archived: false, publishedVersionId: { not: null }, ownerUserId: null } });
    if (!t) throw notFound('Published test');
    await this.prisma.dailyQuiz.upsert({ where: { date: new Date(date) }, create: { date: new Date(date), testId: b.testId }, update: { testId: b.testId } });
    return { date, testId: b.testId, today: istDateString(new Date()) };
  }

  @Get()
  @RequirePermission('content:read')
  list() {
    return this.prisma.dailyQuiz.findMany({ orderBy: { date: 'desc' }, take: 60 });
  }
}
