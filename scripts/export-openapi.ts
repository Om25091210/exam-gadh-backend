/** Writes openapi.json (used to generate the typed client in the frontend monorepo). */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { buildOpenApi, configureApp } from '../src/bootstrap';

async function main() {
  process.env.DATABASE_URL ??= 'postgresql://x@localhost:5432/x';
  process.env.JWT_SECRET ??= 'x'.repeat(40);
  process.env.GOOGLE_CLIENT_IDS ??= 'x';
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication();
  configureApp(app, { logger: false });
  await app.init();
  writeFileSync('openapi.json', JSON.stringify(buildOpenApi(app), null, 2));
  await app.close();
}
main();
