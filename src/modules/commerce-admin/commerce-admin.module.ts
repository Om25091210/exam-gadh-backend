import { Module } from '@nestjs/common';
import { BillingModule } from '../../billing/billing.module';
import { CouponsController, OrdersController, PlansController } from './commerce.controller';
import { CommerceAdminService } from './commerce.service';

@Module({ imports: [BillingModule], controllers: [PlansController, CouponsController, OrdersController], providers: [CommerceAdminService] })
export class CommerceAdminModule {}
