import { Body, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { zod } from '../../common/zod';
import { AdminRequest } from '../admin-auth/admin-auth.types';
import { AdminController, RequirePermission } from '../admin-auth/admin.decorators';
import { couponInput, couponPatch, orderList, planInput, planPatch, reconcileInput, refundInput, repairInput } from './commerce.schemas';
import { CommerceAdminService } from './commerce.service';

const actor = (r: AdminRequest) => ({ admin: r.admin, ip: r.ip });

@AdminController('plans')
export class PlansController {
  constructor(private readonly svc: CommerceAdminService) {}

  @Get()
  @RequirePermission('orders:read')
  list() {
    return this.svc.plans();
  }

  @Post()
  @RequirePermission('plans:write')
  create(@Req() r: AdminRequest, @Body(zod(planInput)) b: z.infer<typeof planInput>) {
    return this.svc.createPlan(actor(r), b);
  }

  @Patch(':id')
  @RequirePermission('plans:write')
  update(@Req() r: AdminRequest, @Param('id') id: string, @Body(zod(planPatch)) b: z.infer<typeof planPatch>) {
    return this.svc.updatePlan(actor(r), id, b);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('plans:write')
  remove(@Req() r: AdminRequest, @Param('id') id: string) {
    return this.svc.deletePlan(actor(r), id);
  }
}

@AdminController('coupons')
export class CouponsController {
  constructor(private readonly svc: CommerceAdminService) {}

  @Get()
  @RequirePermission('orders:read')
  list() {
    return this.svc.coupons();
  }

  @Post()
  @RequirePermission('coupons:write')
  create(@Req() r: AdminRequest, @Body(zod(couponInput)) b: z.infer<typeof couponInput>) {
    return this.svc.createCoupon(actor(r), b);
  }

  @Patch(':code')
  @RequirePermission('coupons:write')
  update(@Req() r: AdminRequest, @Param('code') code: string, @Body(zod(couponPatch)) b: z.infer<typeof couponPatch>) {
    return this.svc.updateCoupon(actor(r), code.toUpperCase(), b);
  }
}

@AdminController('orders')
export class OrdersController {
  constructor(private readonly svc: CommerceAdminService) {}

  @Get()
  @RequirePermission('orders:read')
  list(@Query(zod(orderList)) q: z.infer<typeof orderList>) {
    return this.svc.orders(q);
  }

  @Post('reconcile')
  @HttpCode(200)
  @RequirePermission('orders:refund')
  reconcile(@Body(zod(reconcileInput)) b: z.infer<typeof reconcileInput>) {
    return this.svc.reconcile(b.from, b.to);
  }

  @Post('reconcile/repair')
  @HttpCode(200)
  @RequirePermission('orders:refund')
  repair(@Req() r: AdminRequest, @Body(zod(reconcileInput.merge(repairInput))) b: z.infer<typeof reconcileInput> & z.infer<typeof repairInput>) {
    return this.svc.repair(actor(r), b.razorpayPaymentId, b.from, b.to);
  }

  @Get(':id')
  @RequirePermission('orders:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.order(id);
  }

  @Post(':id/refund')
  @HttpCode(200)
  @RequirePermission('orders:refund')
  refund(@Req() r: AdminRequest, @Param('id', ParseUUIDPipe) id: string, @Body(zod(refundInput)) b: z.infer<typeof refundInput>) {
    return this.svc.refund(actor(r), id, b);
  }
}

