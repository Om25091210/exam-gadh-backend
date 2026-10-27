import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TestKind } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SaveAnswersDto } from './mocktests.dto';
import { MocktestsService } from './mocktests.service';

class ListTestsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  examId?: string;

  @IsOptional()
  @IsEnum(TestKind)
  kind?: TestKind;
}

@ApiTags('tests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class MocktestsController {
  constructor(private readonly tests: MocktestsService) {}

  @Get('tests')
  list(@CurrentUser() user: AuthUser, @Query() q: ListTestsQuery) {
    return this.tests.list(user.id, q);
  }

  @Post('tests/:id/attempts')
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.tests.start(user.id, id);
  }

  @Put('attempts/:id/answers')
  save(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveAnswersDto) {
    return this.tests.saveAnswers(user.id, id, dto.answers);
  }

  @Post('attempts/:id/submit')
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tests.submit(user.id, id);
  }

  @Get('attempts/:id')
  result(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tests.result(user.id, id);
  }
}
