import { Module } from '@nestjs/common';
import { AdminMentorController, MentorController } from './mentor.controller';
import { MentorService } from './mentor.service';

@Module({ controllers: [MentorController, AdminMentorController], providers: [MentorService] })
export class MentorModule {}
