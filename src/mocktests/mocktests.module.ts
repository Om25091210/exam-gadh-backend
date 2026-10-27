import { Module } from '@nestjs/common';
import { MocktestsController } from './mocktests.controller';
import { MocktestsService } from './mocktests.service';

@Module({ controllers: [MocktestsController], providers: [MocktestsService] })
export class MocktestsModule {}
