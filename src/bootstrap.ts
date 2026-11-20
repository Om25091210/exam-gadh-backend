import { INestApplication, ValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { ServerOptions } from 'socket.io';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { badRequest } from './common/api-error';
import { ENV, Env } from './config/env';

/** Socket.IO with the same exact-origin allow-list as the REST API (phones send no Origin, so they are unaffected). */
class AllowListIoAdapter extends IoAdapter {
  constructor(app: INestApplication, private readonly origins: string[]) {
    super(app);
  }
  createIOServer(port: number, options?: ServerOptions) {
    return super.createIOServer(port, { ...options, cors: { origin: this.origins.length ? this.origins : false, credentials: true } });
  }
}

/** Shared by main.ts and the e2e tests so both run the exact same pipeline. */
export function bootstrapApp(app: INestApplication, opts: { logger?: boolean } = {}) {
  const env = app.get<Env>(ENV);
  if (opts.logger !== false) app.useLogger(app.get(Logger));
  app.use(helmet());
  // credentials: true lets the admin cookie travel; origins are an exact allow-list, never '*'.
  app.enableCors({ origin: env.corsOrigins.length ? env.corsOrigins : false, credentials: true });
  app.useWebSocketAdapter(new AllowListIoAdapter(app, env.corsOrigins));
  app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready'] });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        badRequest(
          'VALIDATION_FAILED',
          'Request validation failed',
          errors.map((e) => ({ field: e.property, problems: Object.values(e.constraints ?? {}) })),
        ),
    }),
  );
  return app;
}

export function buildOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('ExamGadh API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config);
}
