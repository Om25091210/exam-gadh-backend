import { Module } from '@nestjs/common';
import { QuestionsModule } from '../questions/questions.module';
import { ExportController, ImportController } from './import.controller';
import { ImportService } from './import.service';

@Module({ imports: [QuestionsModule], controllers: [ImportController, ExportController], providers: [ImportService] })
export class ImportExportModule {}
