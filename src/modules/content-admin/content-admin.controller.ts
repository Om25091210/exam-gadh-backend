import { Body, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { zod } from '../../common/zod';
import { AdminRequest } from '../admin-auth/admin-auth.types';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { Permission } from '../rbac/permissions';
import { ContentAdminService, ENTITIES, listQuerySchema } from './content-admin.service';

const actor = (r: AdminRequest) => ({ admin: r.admin, ip: r.ip });
const statusBody = z.object({ to: z.enum(['draft', 'in_review', 'published', 'archived']) });
const anyBody = z.object({}).catchall(z.unknown());

/**
 * One small controller class per kind of content, all backed by the same service. Each has its own
 * route and its own permission pair (declared statically, as the route-coverage test requires).
 */
function contentController(path: string, key: keyof typeof ENTITIES, perms: { read: Permission; write: Permission }) {
  const e = ENTITIES[key];

  @AdminController(path)
  class ContentCrudController {
    constructor(private readonly svc: ContentAdminService) {}

    @Get()
    @RequirePermission(perms.read)
    list(@Query(zod(listQuerySchema)) q: z.infer<typeof listQuerySchema>) {
      return this.svc.list(e, q as never);
    }

    @Get(':id')
    @RequirePermission(perms.read)
    get(@Param('id') id: string) {
      return this.svc.get(e, id);
    }

    @Post()
    @RequirePermission(perms.write)
    create(@Req() r: AdminRequest, @Body() body: unknown) {
      return this.svc.create(actor(r), e, body);
    }

    @Patch(':id')
    @RequirePermission(perms.write)
    update(@Req() r: AdminRequest, @Param('id') id: string, @Body(zod(anyBody)) body: Record<string, unknown>) {
      return this.svc.update(actor(r), e, id, body);
    }

    @Post(':id/status')
    @HttpCode(200)
    @RequirePermission(perms.write)
    status(@Req() r: AdminRequest, @Param('id') id: string, @Body(zod(statusBody)) b: z.infer<typeof statusBody>) {
      return this.svc.setStatus(actor(r), e, id, b.to);
    }

    @Delete(':id')
    @HttpCode(204)
    @RequirePermission(perms.write)
    remove(@Req() r: AdminRequest, @Param('id') id: string) {
      return this.svc.remove(actor(r), e, id);
    }
  }
  Object.defineProperty(ContentCrudController, 'name', { value: `${key.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase())}Controller` });
  return ContentCrudController;
}

export const CONTENT_CONTROLLERS = [
  contentController('materials', 'materials', { read: 'content:read', write: 'content:write' }),
  contentController('current-affairs', 'current-affairs', { read: 'content:read', write: 'content:write' }),
  contentController('announcements', 'announcements', { read: 'content:read', write: 'announcements:write' }),
  contentController('calendar', 'calendar', { read: 'content:read', write: 'content:write' }),
  contentController('faqs', 'faqs', { read: 'content:read', write: 'content:write' }),
  contentController('interview', 'interview', { read: 'content:read', write: 'content:write' }),
  contentController('notes', 'notes', { read: 'content:read', write: 'content:write' }),
  contentController('canned-replies', 'canned-replies', { read: 'doubts:read', write: 'doubts:answer' }),
  contentController('notification-templates', 'notification-templates', { read: 'content:read', write: 'announcements:write' }),
];
