import { Module } from '@nestjs/common';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminGuard } from './admin.guard';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  controllers: [AdminAuthController, StaffController],
  providers: [AdminAuthService, StaffService, AdminGuard],
  exports: [AdminGuard],
})
export class AdminAuthModule {}
