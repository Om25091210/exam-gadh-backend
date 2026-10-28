import { Module } from '@nestjs/common';
import { TestsCatalogService } from '../tests/tests-catalog.service';
import { AttemptFinalizer } from './attempt-finalizer';
import { AttemptsController } from './attempts.controller';
import { AttemptsService } from './attempts.service';
import { ResultsService } from './results.service';
import { VersionLoader } from './version-loader';

@Module({
  controllers: [AttemptsController],
  providers: [AttemptsService, AttemptFinalizer, ResultsService, VersionLoader, TestsCatalogService],
  exports: [AttemptFinalizer, VersionLoader],
})
export class AttemptsModule {}
