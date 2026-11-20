import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { BattleService } from './battle.service';

@ApiTags('battle')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('battle')
export class BattleController {
  constructor(private readonly svc: BattleService) {}

  /** The student's battle points, record and how many free battles are left. */
  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.svc.me(u.id);
  }

  @Get('history')
  history(@CurrentUser() u: AuthUser) {
    return this.svc.history(u.id);
  }

  @Get('leaderboard')
  leaderboard(@CurrentUser() u: AuthUser) {
    return this.svc.leaderboard(u.id);
  }
}
