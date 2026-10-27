import { Body, Controller, Get, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthUser, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateOrderDto, RedeemCouponDto, VerifyPaymentDto } from './billing.dto';
import { BillingService } from './billing.service';

@ApiTags('billing')
@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  plans() {
    return this.billing.plans();
  }

  @Get('entitlements')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  entitlements(@CurrentUser() user: AuthUser) {
    return this.billing.entitlements(user.id);
  }

  @Post('billing/orders')
  @HttpCode(201)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  order(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto) {
    return this.billing.createOrder(user.id, dto.planId, dto.months);
  }

  @Post('billing/verify')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  verify(@CurrentUser() user: AuthUser, @Body() dto: VerifyPaymentDto) {
    return this.billing.verify(user.id, dto.razorpay_order_id, dto.razorpay_payment_id, dto.razorpay_signature);
  }

  @Post('coupons/redeem')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  redeem(@CurrentUser() user: AuthUser, @Body() dto: RedeemCouponDto) {
    return this.billing.redeemCoupon(user.id, dto.code);
  }

  /** Razorpay -> us. Authenticated by the HMAC of the raw body, not by a user token. */
  @Post('billing/webhook')
  @HttpCode(200)
  @SkipThrottle()
  @ApiExcludeEndpoint()
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature?: string) {
    return this.billing.handleWebhook(req.rawBody, signature);
  }
}
