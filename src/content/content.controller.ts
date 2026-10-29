import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AccessLevel } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AccessService } from '../access/access.service';
import { PrismaService } from '../prisma/prisma.service';
import { ApiError, notFound } from '../common/api-error';

@ApiTags('content')
@Controller()
export class ContentController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  @Get('time')
  time() {
    return { serverTime: new Date().toISOString() };
  }

  @Get('exams')
  exams() {
    return this.prisma.exam.findMany({ where: { active: true }, orderBy: { sort: 'asc' }, include: { papers: { where: { active: true }, orderBy: { sort: 'asc' }, select: { id: true, code: true, stage: true, nameEn: true, nameHi: true, questionCount: true, totalMarks: true, durationMin: true, correctMarks: true, negativeFraction: true, qualifyingPct: true, qualifyingPctReserved: true, countsTowardMerit: true } } } });
  }

  @Get('subjects')
  async subjects() {
    return this.prisma.subject.findMany({ orderBy: { sort: 'asc' }, include: { topics: { orderBy: { sort: 'asc' } } } });
  }

  @Get('notes')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async notes(@CurrentUser() user: AuthUser, @Query('subject') subject?: string) {
    const rows = await this.prisma.note.findMany({
      where: { published: true, ...(subject ? { subjectCode: subject } : {}) },
      select: { id: true, subjectCode: true, titleEn: true, titleHi: true, access: true, version: true },
      orderBy: { id: 'asc' },
    });
    const paid = await this.access.hasPaidAccess(user.id);
    return rows.map((n) => ({ ...n, locked: n.access === AccessLevel.paid && !paid }));
  }

  @Get('notes/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async note(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const note = await this.prisma.note.findFirst({ where: { id, published: true } });
    if (!note) throw notFound('Note');
    if (!(await this.access.canAccess(user.id, note.access))) {
      throw new ApiError(403, 'PAYMENT_REQUIRED', 'A paid plan is required for this note');
    }
    return note;
  }
}
