import { Module } from '@nestjs/common';
import { CONTENT_CONTROLLERS } from './content-admin.controller';
import { ContentAdminService } from './content-admin.service';

@Module({ controllers: CONTENT_CONTROLLERS, providers: [ContentAdminService] })
export class ContentAdminModule {}
