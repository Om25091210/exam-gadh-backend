import { applyDecorators, Controller, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Permission } from '../rbac/permissions';
import { AdminGuard } from './admin.guard';

export const PERMISSION_KEY = 'admin:permission';
export const ANY_ADMIN_KEY = 'admin:any';
export const PRE_MFA_KEY = 'admin:pre-mfa';
export const PASSWORD_CHANGE_OK_KEY = 'admin:password-change-ok';

/** Route needs this permission. The guard re-reads the admin's role from the database on every request. */
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION_KEY, p);
/** Route needs a fully signed-in admin but no specific permission (own profile, own password, logout). */
export const AnyAdmin = () => applyDecorators(SetMetadata(ANY_ADMIN_KEY, true), SetMetadata(PASSWORD_CHANGE_OK_KEY, true));
/** Route is part of the sign-in flow: a session that has not finished 2FA may call it. */
export const PreMfa = () => applyDecorators(SetMetadata(ANY_ADMIN_KEY, true), SetMetadata(PRE_MFA_KEY, true), SetMetadata(PASSWORD_CHANGE_OK_KEY, true));

/** Every controller under /admin uses this so the guard cannot be forgotten. */
export const AdminController = (prefix: string) => applyDecorators(Controller(`admin/${prefix}`), UseGuards(AdminGuard), ApiTags(`admin-${prefix.split('/')[0]}`));
