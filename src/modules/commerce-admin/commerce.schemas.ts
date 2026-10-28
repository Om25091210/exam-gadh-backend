import { z } from 'zod';
import { bool, code, pageQuery, uuid } from '../../common/zod';

const text = (max = 120) => z.string().trim().min(1).max(max);
const price = z.number().int().min(1).max(1_000_000);

export const planInput = z.object({
  id: code.transform((s) => s.toLowerCase()),
  nameEn: text(),
  nameHi: text(),
  // price in rupees for 3, 6 and/or 12 months
  prices: z.object({ '3': price.optional(), '6': price.optional(), '12': price.optional() }).refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'set at least one price (3, 6 or 12 months)' }),
  trialDays: z.number().int().min(0).max(60).default(0),
  topTier: z.boolean().default(false),
  active: z.boolean().default(true),
  examIds: z.array(code).max(20).default([]), // empty = every exam
});
export const planPatch = planInput.omit({ id: true }).partial();

export const couponInput = z.object({ code: z.string().trim().toUpperCase().min(3).max(30).regex(/^[A-Z0-9_-]+$/, 'letters, digits, _ and - only'), planId: z.string().min(2).max(40), days: z.number().int().min(1).max(3650), maxUses: z.number().int().min(1).max(1_000_000).nullable().default(null), expiresAt: z.coerce.date().nullable().default(null), active: z.boolean().default(true) });
export const couponPatch = couponInput.omit({ code: true, planId: true }).partial();

export const orderList = z.object({
  ...pageQuery,
  status: z.enum(['created', 'paid', 'failed', 'refunded']).optional(),
  userId: uuid.optional(),
  planId: z.string().max(40).optional(),
  q: z.string().trim().min(3).max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export const refundInput = z.object({ amountPaise: z.number().int().min(100).optional(), reason: z.string().trim().min(5).max(300) });
export const reconcileInput = z.object({ from: z.coerce.date(), to: z.coerce.date() });
export const repairInput = z.object({ razorpayPaymentId: z.string().min(5).max(64) });
export const flag = bool;
