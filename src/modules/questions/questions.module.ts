import { Module } from '@nestjs/common';
import { PassagesController, QuestionReportsController, QuestionsController } from './questions.controller';
import { QuestionsRepository } from './questions.repository';
import { QuestionsService } from './questions.service';

@Module({ controllers: [QuestionsController, QuestionReportsController, PassagesController], providers: [QuestionsService, QuestionsRepository], exports: [QuestionsService, QuestionsRepository] })
export class QuestionsModule {}
