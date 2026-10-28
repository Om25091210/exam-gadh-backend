import { StaffRole } from '@prisma/client';
import type { Request } from 'express';
import { Permission } from '../rbac/permissions';

export const ADMIN_COOKIE = 'eg_admin';

export interface AdminPrincipal {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  sessionId: string;
  csrfToken: string;
  mfaDone: boolean;
  mustChangePassword: boolean;
  permissions: Permission[];
}

export type AdminRequest = Request & { admin: AdminPrincipal };
