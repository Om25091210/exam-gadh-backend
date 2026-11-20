import { Module } from '@nestjs/common';
import { BattleController } from './battle.controller';
import { BattleEngine } from './battle.engine';
import { BattleGateway } from './battle.gateway';
import { BattleService } from './battle.service';

@Module({ controllers: [BattleController], providers: [BattleService, BattleEngine, BattleGateway] })
export class BattleModule {}
