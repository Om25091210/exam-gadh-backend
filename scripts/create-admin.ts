/**
 * Creates the first (or any) staff account from the server shell. The temporary password is printed once;
 * the person must change it and enrol 2FA at first sign-in.
 *   pnpm admin:create --email owner@example.in --name "Owner" [--role SUPER_ADMIN]
 */
import { PrismaClient, StaffRole } from '@prisma/client';
import { hashPassword, temporaryPassword } from '../src/modules/admin-auth/secrets';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  const role = (arg('role') ?? 'SUPER_ADMIN') as StaffRole;
  if (!email || !name || !(role in StaffRole)) {
    console.error('usage: pnpm admin:create --email <e-mail> --name <name> [--role SUPER_ADMIN|ADMIN|CONTENT_EDITOR|TEACHER|SUPPORT]');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    if (await prisma.adminUser.findUnique({ where: { email } })) {
      console.error(`an account for ${email} already exists`);
      process.exit(1);
    }
    const temp = temporaryPassword();
    await prisma.adminUser.create({ data: { email, name, role, passwordHash: await hashPassword(temp), mustChangePassword: true } });
    await prisma.auditLog.create({ data: { actorType: 'system', actor: 'cli', action: 'staff.created', target: email, targetType: 'admin', after: { role } } });
    console.log(`Created ${role} ${email}\nTemporary password (shown once): ${temp}`);
  } finally {
    await prisma.$disconnect();
  }
}

main();
