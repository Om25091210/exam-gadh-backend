import { Module } from '@nestjs/common';
import { AdminDailyQuizController, StudentContentController } from './student-content.controller';
import { StudentContentService } from './student-content.service';

@Module({ controllers: [StudentContentController, AdminDailyQuizController], providers: [StudentContentService], exports: [StudentContentService] })
export class StudentContentModule {}
