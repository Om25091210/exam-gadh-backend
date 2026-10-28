import { StaffRole } from '@prisma/client';

/**
 * The permission matrix. docs/PERMISSIONS.md is generated from this file's intent; keep them in step.
 * Every admin route must declare exactly one of these (or be explicitly login-only); undeclared routes are denied.
 */
export const PERMISSIONS = [
  'dashboard:read',
  'users:read',
  'users:suspend',
  'users:grant-access',
  'content:read',
  'content:write',
  'content:publish',
  'taxonomy:write',
  'exam-config:write',
  'test:write',
  'test:publish',
  'series:write',
  'import:run',
  'reports:read',
  'reports:resolve',
  'results:read',
  'doubts:read',
  'doubts:answer',
  'mentor:manage',
  'orders:read',
  'orders:refund',
  'plans:write',
  'coupons:write',
  'announcements:write',
  'audit:read',
  'settings:write',
  'staff:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const without = (...drop: Permission[]) => new Set<Permission>([...PERMISSIONS].filter((p) => !drop.includes(p)));

export const ROLE_PERMISSIONS: Record<StaffRole, ReadonlySet<Permission>> = {
  // Everything, including staff management.
  SUPER_ADMIN: ALL,
  // Everything except managing staff accounts.
  ADMIN: without('staff:manage'),
  // Writes drafts and builds tests; cannot publish (maker/checker) or touch users, money or settings.
  CONTENT_EDITOR: new Set<Permission>(['content:read', 'content:write', 'test:write', 'import:run', 'reports:read', 'reports:resolve', 'results:read', 'taxonomy:write']),
  // Answers doubts and drafts study plans; read-only on content and results.
  TEACHER: new Set<Permission>(['content:read', 'doubts:read', 'doubts:answer', 'mentor:manage', 'results:read', 'reports:read']),
  // Helps students: can look people up and see orders and doubts, but cannot change content, access or money.
  SUPPORT: new Set<Permission>(['users:read', 'orders:read', 'doubts:read', 'reports:read']),
};

export const can = (role: StaffRole, permission: Permission): boolean => ROLE_PERMISSIONS[role].has(permission);
export const permissionsOf = (role: StaffRole): Permission[] => [...ROLE_PERMISSIONS[role]].sort();
