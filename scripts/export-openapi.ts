/** Writes openapi.json (used to generate the typed client in the frontend monorepo). */
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { buildOpenApi, bootstrapApp } from '../src/bootstrap';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  process.env.DATABASE_URL ??= 'postgresql://x@localhost:5432/x';
  process.env.JWT_SECRET ??= 'x'.repeat(40);
  process.env.GOOGLE_CLIENT_IDS ??= 'x';
  process.env.ADMIN_TOTP_KEY ??= Buffer.alloc(32, 1).toString('base64');
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService) // generating the contract needs no database
    .useValue({})
    .compile();
  const app = mod.createNestApplication();
  bootstrapApp(app, { logger: false });
  await app.init();
  writeFileSync('openapi.json', JSON.stringify(buildOpenApi(app), null, 2));
  await app.close();
}
main();
