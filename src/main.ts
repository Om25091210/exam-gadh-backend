import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildOpenApi, configureApp } from './bootstrap';
import { ENV, Env } from './config/env';

async function main() {
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
  configureApp(app);
  const env = app.get<Env>(ENV);
  if (env.nodeEnv !== 'production') SwaggerModule.setup('docs', app, buildOpenApi(app));
  app.enableShutdownHooks();
  await app.listen(env.port, '0.0.0.0');
}

main().catch((err) => {
  // Config errors etc. must be visible and stop the process.
  console.error(err);
  process.exit(1);
});
