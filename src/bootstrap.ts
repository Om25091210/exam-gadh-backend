import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { badRequest } from './common/api-error';
import { ENV, Env } from './config/env';

/** Shared by main.ts and the e2e tests so both run the exact same pipeline. */
export function bootstrapApp(app: INestApplication, opts: { logger?: boolean } = {}) {
  const env = app.get<Env>(ENV);
  if (opts.logger !== false) app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors({ origin: env.corsOrigins.length ? env.corsOrigins : false, credentials: false });
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
