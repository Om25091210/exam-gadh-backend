import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { AdminGuard } from '../src/modules/admin-auth/admin.guard';
import { ANY_ADMIN_KEY, PERMISSION_KEY } from '../src/modules/admin-auth/admin.decorators';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { createApp } from './helpers';

/**
 * Authorization is enforced by metadata, so this test fails the build when a new route is added without it:
 *  - every /admin route has AdminGuard AND declares a permission (or is explicitly "any signed-in admin"/sign-in flow);
 *  - every other route is protected by the student JwtAuthGuard unless it is on the reviewed public list below.
 */
const PUBLIC_ROUTES = new Set([
  'HealthController.live',
  'HealthController.ready',
  'ContentController.time',
  'ContentController.exams',
  'ContentController.subjects',
  'BillingController.plans',
  'BillingController.webhook', // authenticated by HMAC of the body
  'AuthController.google',
  'AuthController.refresh',
  'AdminAuthController.login', // the sign-in entry point itself
]);

describe('every route is protected', () => {
  let app: INestApplication;
  beforeAll(async () => ({ app } = await createApp()));
  afterAll(() => app.close());

  it('has authorization metadata on every handler', () => {
    const container = app.get(ModulesContainer);
    const failures: string[] = [];
    let checked = 0;
    for (const mod of container.values()) {
      for (const wrapper of mod.controllers.values()) {
        const klass = wrapper.metatype as { name: string; prototype: Record<string, unknown> };
        if (!klass || Reflect.getMetadata(PATH_METADATA, klass) === undefined) continue;
        const basePath = String(Reflect.getMetadata(PATH_METADATA, klass));
        const isAdmin = basePath.startsWith('admin');
        const classGuards: unknown[] = Reflect.getMetadata('__guards__', klass) ?? [];
        for (const name of Object.getOwnPropertyNames(klass.prototype)) {
          const handler = klass.prototype[name] as (...a: unknown[]) => unknown;
          if (name === 'constructor' || typeof handler !== 'function' || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
          checked++;
          const id = `${klass.name}.${name}`;
          const guards = [...classGuards, ...((Reflect.getMetadata('__guards__', handler) as unknown[]) ?? [])];
          const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
          if (PUBLIC_ROUTES.has(id)) continue;
          if (isAdmin) {
            if (!guards.includes(AdminGuard)) failures.push(`${id} (${method}): missing AdminGuard`);
            const declared = Reflect.getMetadata(PERMISSION_KEY, handler) ?? Reflect.getMetadata(PERMISSION_KEY, klass) ?? Reflect.getMetadata(ANY_ADMIN_KEY, handler) ?? Reflect.getMetadata(ANY_ADMIN_KEY, klass);
            if (!declared) failures.push(`${id} (${method}): no permission declared`);
          } else if (!guards.includes(JwtAuthGuard)) {
            failures.push(`${id} (${method}): no JwtAuthGuard and not on the public list`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  });

  it('the public list only names routes that exist (no stale entries)', () => {
    const container = app.get(ModulesContainer);
    const existing = new Set<string>();
    for (const mod of container.values())
      for (const w of mod.controllers.values()) {
        const k = w.metatype as { name: string; prototype: Record<string, unknown> };
        if (k) for (const n of Object.getOwnPropertyNames(k.prototype)) existing.add(`${k.name}.${n}`);
      }
    for (const id of PUBLIC_ROUTES) expect(existing).toContain(id);
  });
});
