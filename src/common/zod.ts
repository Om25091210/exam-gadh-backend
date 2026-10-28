import { PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { badRequest } from './api-error';

/** Validates a body/query with a shared zod schema and answers with the standard VALIDATION_FAILED error. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw badRequest(
        'VALIDATION_FAILED',
        'Request validation failed',
        r.error.issues.map((i) => ({ field: i.path.join('.'), problems: [i.message] })),
      );
    }
    return r.data;
  }
}

export const zod = <T>(schema: z.ZodType<T>) => new ZodPipe<T>(schema);

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export const skipTake = (q: { page: number; pageSize: number }) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });

export const bool = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
export const code = z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, _ and - only');
export const uuid = z.string().uuid();
