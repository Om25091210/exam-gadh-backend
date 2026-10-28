/** Prints docs/PERMISSIONS.md from the permission matrix in code:  pnpm ts-node --transpile-only scripts/gen-permissions-doc.ts > PERMISSIONS.md */
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/modules/rbac/permissions';

const roles = Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>;
const lines = [
  '# Permissions matrix',
  '',
  'Generated from `src/modules/rbac/permissions.ts` in `exam-gadh-backend`. Do not edit by hand; change the code and regenerate.',
  '',
  '| Permission | ' + roles.join(' | ') + ' |',
  '|---|' + roles.map(() => ':---:').join('|') + '|',
  ...PERMISSIONS.map((p) => `| \`${p}\` | ` + roles.map((r) => (ROLE_PERMISSIONS[r].has(p) ? '✅' : '–')).join(' | ') + ' |'),
  '',
  '## How it is enforced',
  '',
  '- **Admin routes:** every controller under `/v1/admin/*` is declared with `@AdminController(...)`, which installs `AdminGuard`. Every handler declares one permission (`@RequirePermission`) or is explicitly "any signed-in admin" (`@AnyAdmin`) or part of the sign-in flow (`@PreMfa`). A handler that declares nothing is **denied** (`PERMISSION_UNDECLARED`).',
  '- **Always fresh:** the guard loads the session and the admin row from the database on every request. A role change, a disabled account, a revoked session or a password reset applies to the very next request; nothing is cached.',
  '- **2FA is mandatory** for every staff role: a session that has only passed the password step cannot call anything except the 2FA routes.',
  '- **CSRF + Origin:** unsafe methods need the `x-csrf-token` bound to the session and, when `CORS_ORIGINS` is set, an allowed `Origin`.',
  '- **Students:** every non-public route uses `JwtAuthGuard` (bearer token + live session row + account status). Students only ever reach their own attempts, results, bookmarks, notes, doubts, orders and notifications: all lookups filter by the authenticated user id and answer 404 for anything else (no information about other students\' ids).',
  '- **Suspension:** suspending a student ends all their sessions and blocks sign-in; effective on the next request.',
  '- **Guardrail test:** `test/route-coverage.e2e-spec.ts` fails the build if any route lacks a guard/permission and is not on the reviewed public list.',
  '',
  '## Public routes (reviewed list)',
  '',
  '`GET /health`, `GET /health/ready`, `GET /v1/time`, `GET /v1/exams`, `GET /v1/subjects`, `GET /v1/plans`, `POST /v1/auth/google`, `POST /v1/auth/refresh`, `POST /v1/billing/webhook` (HMAC), `POST /v1/admin/auth/login`.',
  '',
  '## Roles in plain words',
  '',
  '- **SUPER_ADMIN:** everything, including creating staff and resetting their 2FA/passwords. There is always at least one active.',
  '- **ADMIN:** everything except staff management.',
  '- **CONTENT_EDITOR:** writes questions, builds tests, runs imports, handles question reports. Cannot publish (a second person publishes), cannot touch users, money or settings.',
  '- **TEACHER:** answers doubts, prepares study plans, reads results. Read-only on content.',
  '- **SUPPORT:** looks up students, orders and doubts to help them. Cannot change anything.',
  '',
];
console.log(lines.join('\n'));
