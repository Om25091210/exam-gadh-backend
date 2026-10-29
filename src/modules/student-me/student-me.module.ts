import { Module } from '@nestjs/common';
import { StudentContentModule } from '../student-content/student-content.module';
import { AuthModule } from '../../auth/auth.module';
import { AccountService } from './account.service';
import { AnalyticsService } from './analytics.service';
import { HomeService } from './home.service';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({ imports: [StudentContentModule, AuthModule], controllers: [MeController], providers: [HomeService, AnalyticsService, MeService, AccountService] })
export class StudentMeModule {}
