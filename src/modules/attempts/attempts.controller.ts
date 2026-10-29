import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TestKind } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { TestsCatalogService } from '../tests/tests-catalog.service';
import { SaveStateDto, StartAttemptDto, SubmitDto } from './attempts.dto';
import { AttemptsService } from './attempts.service';
import { ResultsService } from './results.service';

class CatalogQuery {
  @IsOptional() @IsString() @MaxLength(40) examId?: string;
  @IsOptional() @IsEnum(TestKind) kind?: TestKind;
  @IsOptional() @IsString() @MaxLength(40) subjectCode?: string;
  @IsOptional() @IsString() @MaxLength(40) topicCode?: string;
  @IsOptional() @IsIn(['free', 'paid']) access?: 'free' | 'paid';
  @IsOptional() @IsString() @MaxLength(40) seriesId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1900) @Max(2100) pyqYear?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
}

class LeaderboardQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/** The browser tab / app instance id; two tabs of one attempt have different ids. */
const clientIdOf = (h?: string) => (h && h.length <= 64 ? h : 'default');

@ApiTags('tests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class AttemptsController {
  constructor(
    private readonly catalog: TestsCatalogService,
    private readonly attempts: AttemptsService,
    private readonly results: ResultsService,
  ) {}

  @Get('tests')
  list(@CurrentUser() u: AuthUser, @Query() q: CatalogQuery) {
    return this.catalog.list(u.id, { ...q, page: q.page ?? 1, pageSize: q.pageSize ?? 20 });
  }

  @Get('tests/:id')
  detail(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.detail(u.id, id);
  }

  @Get('tests/:id/leaderboard')
  leaderboard(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: LeaderboardQuery) {
    return this.results.leaderboard(u.id, id, q.limit ?? 50);
  }

  @Post('tests/:id/attempts')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  start(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StartAttemptDto, @Headers('x-client-id') client?: string) {
    return this.attempts.startOrResume(u.id, id, dto, clientIdOf(client));
  }

  @Get('attempts/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  open(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Headers('x-client-id') client?: string) {
    return this.attempts.open(u.id, id, clientIdOf(client));
  }

  @Put('attempts/:id/state')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  save(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveStateDto, @Headers('x-client-id') client?: string) {
    return this.attempts.saveState(u.id, id, dto, clientIdOf(client));
  }

  @Post('attempts/:id/sections/advance')
  @HttpCode(200)
  advance(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Headers('x-client-id') client?: string) {
    return this.attempts.advanceSection(u.id, id, clientIdOf(client));
  }

  @Post('attempts/:id/submit')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async submit(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitDto) {
    await this.attempts.submit(u.id, id, dto.submitKey, dto.answers);
    return this.results.result(u.id, id);
  }

  @Get('attempts/:id/result')
  result(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.results.result(u.id, id);
  }

  @Get('attempts/:id/review')
  review(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.results.review(u.id, id);
  }
}
