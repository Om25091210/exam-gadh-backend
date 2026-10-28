import { Module } from '@nestjs/common';
import { AdminUsersController, AuditController, DashboardController, SettingsController } from './admin-ops.controller';
import { AdminUsersService } from './admin-users.service';
import { AuditSettingsService } from './audit-settings.service';
import { DashboardService } from './dashboard.service';

@Module({ controllers: [AdminUsersController, AuditController, SettingsController, DashboardController], providers: [AdminUsersService, AuditSettingsService, DashboardService] })
export class AdminOpsModule {}
