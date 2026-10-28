import { Inject, Injectable } from '@nestjs/common';
import Razorpay from 'razorpay';
import { ENV, Env } from '../config/env';
import { ApiError } from '../common/api-error';

export interface GatewayOrder {
  id: string;
}

/** Port around the Razorpay SDK so tests can stub the network call. */
export interface GatewayPayment {
  id: string;
  orderId: string;
  amountPaise: number;
  status: 'captured' | 'failed' | 'refunded' | 'created' | 'authorized';
  method?: string;
  createdAt: Date;
}

export abstract class PaymentGateway {
  abstract createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<GatewayOrder>;
  /** Refunds (part of) a captured payment; returns the gateway's refund id. */
  abstract refund(paymentId: string, amountPaise: number, notes: Record<string, string>): Promise<{ id: string }>;
  /** Every payment the gateway recorded in [from, to] (for reconciliation). */
  abstract listPayments(from: Date, to: Date): Promise<GatewayPayment[]>;
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

  async refund(paymentId: string, amountPaise: number, notes: Record<string, string>) {
    if (!this.client) throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not configured');
    const r = await this.client.payments.refund(paymentId, { amount: amountPaise, notes });
    return { id: r.id };
  }

  async listPayments(from: Date, to: Date): Promise<GatewayPayment[]> {
    if (!this.client) throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not configured');
    const out: GatewayPayment[] = [];
    for (let skip = 0; skip < 5000; skip += 100) {
      const page = await this.client.payments.all({ from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000), count: 100, skip });
      for (const p of page.items as Array<{ id: string; order_id: string; amount: number | string; status: string; method?: string; created_at: number }>) {
        out.push({ id: p.id, orderId: p.order_id, amountPaise: Number(p.amount), status: p.status as GatewayPayment['status'], method: p.method, createdAt: new Date(p.created_at * 1000) });
      }
      if (page.items.length < 100) break;
    }
    return out;
  }
}
