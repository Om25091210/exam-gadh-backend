import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PaymentGateway, RazorpayGateway } from './razorpay.gateway';

@Module({
  controllers: [BillingController],
  providers: [BillingService, { provide: PaymentGateway, useClass: RazorpayGateway }],
})
export class BillingModule {}
