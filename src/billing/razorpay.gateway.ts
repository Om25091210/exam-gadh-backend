import { Inject, Injectable } from '@nestjs/common';
import Razorpay from 'razorpay';
import { ENV, Env } from '../config/env';
import { ApiError } from '../common/api-error';

export interface GatewayOrder {
  id: string;
}

/** Port around the Razorpay SDK so tests can stub the network call. */
export abstract class PaymentGateway {
  abstract createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder>;
  abstract get keyId(): string;
}

@Injectable()
export class RazorpayGateway extends PaymentGateway {
  private readonly client?: Razorpay;

  constructor(@Inject(ENV) private readonly env: Env) {
    super();
    if (env.razorpayKeyId && env.razorpayKeySecret) {
      this.client = new Razorpay({ key_id: env.razorpayKeyId, key_secret: env.razorpayKeySecret });
    }
  }

  get keyId() {
    return this.env.razorpayKeyId;
  }

  async createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }) {
    if (!this.client) throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not configured');
    const o = await this.client.orders.create({
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.receipt,
      notes: input.notes,
    });
    return { id: o.id };
  }
}
