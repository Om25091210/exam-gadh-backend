import { Module } from '@nestjs/common';
import { AdminDoubtsController, DoubtsController } from './doubts.controller';
import { DoubtsService } from './doubts.service';

@Module({ controllers: [DoubtsController, AdminDoubtsController], providers: [DoubtsService] })
export class DoubtsModule {}
