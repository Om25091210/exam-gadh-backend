import { HttpException } from '@nestjs/common';

/** Every error leaves the API as { error: { code, message, details? } } with a stable machine code. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export const unauthorized = (code = 'UNAUTHENTICATED', message = 'Sign in required') =>
  new ApiError(401, code, message);
export const forbidden = (code: string, message: string) => new ApiError(403, code, message);
export const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);
export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);
