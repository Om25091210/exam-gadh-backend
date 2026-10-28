import { can, PERMISSIONS, permissionsOf, ROLE_PERMISSIONS } from './permissions';

describe('permission matrix', () => {
  it('super admin has every permission, admin has all but staff management', () => {
    for (const p of PERMISSIONS) expect(can('SUPER_ADMIN', p)).toBe(true);
    expect(can('ADMIN', 'staff:manage')).toBe(false);
    expect(permissionsOf('ADMIN')).toHaveLength(PERMISSIONS.length - 1);
  });

  it('only super admin manages staff', () => {
    expect(PERMISSIONS.filter((p) => p === 'staff:manage').every((p) => (['SUPER_ADMIN', 'ADMIN', 'CONTENT_EDITOR', 'TEACHER', 'SUPPORT'] as const).filter((r) => can(r, p)).join() === 'SUPER_ADMIN')).toBe(true);
  });

  it('content editors write but never publish, suspend users, touch money or settings', () => {
    for (const p of ['content:publish', 'test:publish', 'series:write', 'users:suspend', 'users:grant-access', 'orders:refund', 'plans:write', 'coupons:write', 'settings:write', 'audit:read'] as const) {
      expect(can('CONTENT_EDITOR', p)).toBe(false);
    }
    expect(can('CONTENT_EDITOR', 'content:write')).toBe(true);
    expect(can('CONTENT_EDITOR', 'import:run')).toBe(true);
  });

  it('teachers answer doubts but cannot edit content or see users', () => {
    expect(can('TEACHER', 'doubts:answer')).toBe(true);
    expect(can('TEACHER', 'content:write')).toBe(false);
    expect(can('TEACHER', 'users:read')).toBe(false);
  });

  it('support is read-only on people, orders and doubts', () => {
    expect([...ROLE_PERMISSIONS.SUPPORT].sort()).toEqual(['doubts:read', 'orders:read', 'reports:read', 'users:read']);
  });

  it('every role only holds known permissions', () => {
    for (const set of Object.values(ROLE_PERMISSIONS)) for (const p of set) expect(PERMISSIONS).toContain(p);
  });
});
