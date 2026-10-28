import { Module } from '@nestjs/common';
import { AttemptsModule } from '../attempts/attempts.module';
import { RegradeService } from './regrade.service';
import { SeriesService } from './series.service';
import { SeriesController, TestsAdminController } from './tests-admin.controller';
import { TestsAdminService } from './tests-admin.service';
import { TestsAnalyticsService } from './tests-analytics.service';

@Module({ imports: [AttemptsModule], controllers: [TestsAdminController, SeriesController], providers: [TestsAdminService, TestsAnalyticsService, RegradeService, SeriesService] })
export class TestsAdminModule {}
