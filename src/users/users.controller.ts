import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Language } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { publicUser } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { notFound, badRequest } from '../common/api-error';

class UpdateMeDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiProperty({ required: false, enum: ['hi', 'en'] })
  @IsOptional()
  @IsIn(['hi', 'en'])
  language?: Language;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  district?: string;

  @ApiProperty({ required: false, description: 'Exam id, e.g. cgpsc' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  targetExam?: string;
}

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async me(@CurrentUser() auth: AuthUser) {
    const user = await this.prisma.user.findUnique({ where: { id: auth.id } });
    if (!user) throw notFound('User');
    const now = new Date();
    const entitlements = await this.prisma.entitlement.findMany({
      where: { userId: auth.id, revokedAt: null, endsAt: { gt: now } },
      select: { id: true, planId: true, endsAt: true },
      orderBy: { endsAt: 'desc' },
    });
    return { ...publicUser(user), entitlements };
  }

  @Patch()
  async update(@CurrentUser() auth: AuthUser, @Body() dto: UpdateMeDto) {
    if (dto.targetExam) {
      const exam = await this.prisma.exam.findUnique({ where: { id: dto.targetExam } });
      if (!exam) throw badRequest('UNKNOWN_EXAM', 'Unknown exam');
    }
    const user = await this.prisma.user.update({ where: { id: auth.id }, data: dto });
    return publicUser(user);
  }
}
