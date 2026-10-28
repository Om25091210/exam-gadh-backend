import { Body, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { StaffRole } from '@prisma/client';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AdminController, RequirePermission } from './admin.decorators';
import { AdminRequest } from './admin-auth.types';
import { StaffService } from './staff.service';

class CreateStaffDto {
  @ApiProperty() @IsEmail() @MaxLength(200) email!: string;
  @ApiProperty() @IsString() @Length(2, 80) name!: string;
  @ApiProperty({ enum: StaffRole }) @IsEnum(StaffRole) role!: StaffRole;
}

class UpdateStaffDto {
  @ApiProperty({ required: false, enum: StaffRole }) @IsOptional() @IsEnum(StaffRole) role?: StaffRole;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() disabled?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @Length(2, 80) name?: string;
}

@AdminController('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequirePermission('staff:manage')
  list() {
    return this.staff.list();
  }

  @Post()
  @RequirePermission('staff:manage')
  create(@Req() req: AdminRequest, @Body() dto: CreateStaffDto) {
    return this.staff.create(req.admin, dto, req.ip);
  }

  @Patch(':id')
  @RequirePermission('staff:manage')
  update(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStaffDto) {
    return this.staff.update(req.admin, id, dto, req.ip);
  }

  @Post(':id/reset-mfa')
  @HttpCode(204)
  @RequirePermission('staff:manage')
  resetMfa(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.resetMfa(req.admin, id, req.ip);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @RequirePermission('staff:manage')
  resetPassword(@Req() req: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.resetPassword(req.admin, id, req.ip);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(204)
  @RequirePermission('staff:manage')
  revoke(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.revokeSessions(id);
  }
}
