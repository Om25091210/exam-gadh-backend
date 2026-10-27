import { execSync } from 'node:child_process';

export default async function globalSetup() {
  const url = process.env.DATABASE_URL_TEST ?? 'postgresql://postgres@localhost:5433/examgadh_test';
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url } });
}
