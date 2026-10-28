import { Body, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { zod } from '../../common/zod';
import { AdminRequest } from '../admin-auth/admin-auth.types';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { AdminUsersService, grantInput, revokeEntitlementInput, suspendInput, userListQuery } from './admin-users.service';
import { auditQuery, AuditSettingsService } from './audit-settings.service';
import { dashboardQuery, DashboardService } from './dashboard.service';

const actor = (r: AdminRequest) => ({ admin: r.admin, ip: r.ip });

@AdminController('users')
export class AdminUsersController {
  constructor(private readonly svc: AdminUsersService) {}

  @Get()
  @RequirePermission('users:read')
  list(@Query(zod(userListQuery)) q: z.infer<typeof userListQuery>) {
    return this.svc.list(q);
  }

  @Get(':id')
  @RequirePermission('users:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }

  @Post(':id/suspend')
  @HttpCode(204)
  @RequirePermission('users:suspend')
  suspend(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(suspendInput)) b: z.infer<typeof suspendInput>) {
    return this.svc.suspend(actor(r), id, b.reason);
  }

  @Post(':id/activate')
  @HttpCode(204)
  @RequirePermission('users:suspend')
  activate(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.activate(actor(r), id);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(204)
  @RequirePermission('users:suspend')
  revokeSessions(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.revokeSessions(actor(r), id);
  }

  @Post(':id/grant-access')
  @RequirePermission('users:grant-access')
  grant(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(grantInput)) b: z.infer<typeof grantInput>) {
    return this.svc.grant(actor(r), id, b);
  }

  @Post('entitlements/:eid/revoke')
  @HttpCode(204)
  @RequirePermission('users:grant-access')
  revokeEntitlement(@Req() r: AdminRequest, @Param('eid', ParseUUIDPipe) eid: string, @Body(zod(revokeEntitlementInput)) b: z.infer<typeof revokeEntitlementInput>) {
    return this.svc.revokeEntitlement(actor(r), eid, b.reason);
  }
}

@AdminController('audit')
export class AuditController {
  constructor(private readonly svc: AuditSettingsService) {}

  @Get()
  @RequirePermission('audit:read')
  list(@Query(zod(auditQuery)) q: z.infer<typeof auditQuery>) {
    return this.svc.auditList(q);
  }
}

@AdminController('settings')
export class SettingsController {
  constructor(private readonly svc: AuditSettingsService) {}

  @Get()
  @RequirePermission('settings:write')
  all() {
    return this.svc.allSettings();
  }

  @Put(':key')
  @RequirePermission('settings:write')
  set(@Req() r: AdminRequest, @Param('key') key: string, @Body() body: { value?: unknown }) {
    return this.svc.setSetting(actor(r), key, body?.value);
  }
}

@AdminController('dashboard')
export class DashboardController {
  constructor(private readonly svc: DashboardService) {}

  @Get()
  @RequirePermission('dashboard:read')
  get(@Query(zod(dashboardQuery)) q: z.infer<typeof dashboardQuery>) {
    return this.svc.get(q);
  }
}
