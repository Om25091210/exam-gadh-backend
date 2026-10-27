import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from './api-error';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ApiError) {
      return res.status(exception.getStatus()).json({
        error: { code: exception.code, message: exception.message, details: exception.details },
      });
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : ((body as { message?: string }).message ?? 'Error');
      const code = status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
      return res.status(status).json({ error: { code, message: Array.isArray(message) ? message.join('; ') : message } });
    }
    // Unknown error: log with stack, never leak internals to the client.
    this.log.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  }
}
