import { Global, Module } from '@nestjs/common';
import { NotificationJobs } from './notification-jobs';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService, NotificationJobs], exports: [NotificationsService, NotificationJobs] })
export class NotificationsModule {}
