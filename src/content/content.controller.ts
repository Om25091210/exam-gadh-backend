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
      select: { id: true, subjectCode: true, titleEn: true, titleHi: true, access: true, version: true, sections: true, updatedAt: true, _count: { select: { likes: true } } },
      orderBy: { id: 'asc' },
    });
    const [paid, liked] = await Promise.all([this.access.hasPaidAccess(user.id), this.prisma.noteLike.findMany({ where: { userId: user.id }, select: { noteId: true } })]);
    const mine = new Set(liked.map((l) => l.noteId));
    // the list never carries the body (a paid note shows only its title): just how long it takes to read and how many liked it
    return rows.map(({ sections, _count, ...n }) => ({ ...n, locked: n.access === AccessLevel.paid && !paid, likes: _count.likes, liked: mine.has(n.id), sectionCount: Array.isArray(sections) ? sections.length : 0, readMinutes: Math.max(1, Math.round(JSON.stringify(sections ?? []).split(/\s+/).length / 220)) }));
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
    const [likes, liked] = await Promise.all([this.prisma.noteLike.count({ where: { noteId: id } }), this.prisma.noteLike.findUnique({ where: { userId_noteId: { userId: user.id, noteId: id } } })]);
    return { ...note, likes, liked: !!liked };
  }
}
