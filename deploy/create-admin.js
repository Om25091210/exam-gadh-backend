// Production twin of scripts/create-admin.ts (the runtime image has no ts-node). Run inside the api image:
//   docker run --rm --env-file api.env -v $PWD/src-backend/deploy/create-admin.js:/app/create-admin.js examgadh-api node create-admin.js --email a@b.in --name "Owner"
const { PrismaClient } = require('@prisma/client');
const { hashPassword, temporaryPassword } = require('./dist/modules/admin-auth/secrets');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
(async () => {
  const email = (arg('email') || '').trim().toLowerCase();
  const name = (arg('name') || '').trim();
  const role = arg('role') || 'SUPER_ADMIN';
  if (!email || !name) { console.error('usage: --email <e-mail> --name <name> [--role SUPER_ADMIN]'); process.exit(2); }
  const prisma = new PrismaClient();
  try {
    if (await prisma.adminUser.findUnique({ where: { email } })) { console.error(`an account for ${email} already exists`); process.exit(1); }
    const temp = temporaryPassword();
    await prisma.adminUser.create({ data: { email, name, role, passwordHash: await hashPassword(temp), mustChangePassword: true } });
    await prisma.auditLog.create({ data: { actorType: 'system', actor: 'cli', action: 'staff.created', target: email, targetType: 'admin', after: { role } } });
    console.log(`Created ${role} ${email}\nTemporary password (shown once): ${temp}`);
  } finally { await prisma.$disconnect(); }
})();
