import { Module } from '@nestjs/common';
import { StudentContentModule } from '../student-content/student-content.module';
import { AnalyticsService } from './analytics.service';
import { HomeService } from './home.service';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({ imports: [StudentContentModule], controllers: [MeController], providers: [HomeService, AnalyticsService, MeService] })
export class StudentMeModule {}
