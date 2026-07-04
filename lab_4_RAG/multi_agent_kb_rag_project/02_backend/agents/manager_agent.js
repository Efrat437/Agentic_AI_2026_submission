import crypto from 'crypto';
import {
  createManagedUser,
  deleteManagedUser,
  activateManagedUser,
  assignPermissionToUser,
  auditLoginAttempt,
  logQueryExecution,
} from '../security/access_control_repository.js';
import { invalidateUserPermissionCache } from '../security/secure_sql_orchestrator.js';

const MANAGER_ROLES = new Set(
  String(process.env.ADMIN_ROLES || 'admin,supervisor')
    .split(',')
    .map((r) => String(r || '').trim().toLowerCase())
    .filter(Boolean),
);

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

function asRole(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function getManagerAccessDecision({ role = '', permissions = null } = {}) {
  const normalizedRole = asRole(role);
  if (MANAGER_ROLES.has(normalizedRole)) {
    return { allowed: true, via: 'admin-role' };
  }

  const canManageUsers = Boolean(permissions?.rolePermissions?.can_manage_users?.enabled);
  if (canManageUsers) {
    return { allowed: true, via: 'can_manage_users' };
  }

  if (Boolean(permissions?.canWrite)) {
    return { allowed: true, via: 'can_write' };
  }

  return { allowed: false, via: 'denied' };
}

export function canUseManagerAgent({ role = '', permissions = null } = {}) {
  return getManagerAccessDecision({ role, permissions }).allowed;
}

function normalizeAction(action = '') {
  const raw = String(action || '').trim().toLowerCase();
  if (['create', 'create_user', 'add_user', 'new_user'].includes(raw)) return 'create_user';
  if (['delete', 'delete_user', 'remove_user'].includes(raw)) return 'delete_user';
  if (['deactivate', 'deactivate_user', 'disable_user', 'suspend_user'].includes(raw)) return 'deactivate_user';
  if (['activate', 'activate_user', 'enable_user', 'reactivate_user'].includes(raw)) return 'activate_user';
  if (['assign_permission', 'grant_permission', 'assign'].includes(raw)) return 'assign_permission';
  return raw;
}

export async function runManagerAgentOperation({
  action = '',
  payload = {},
  actorUserId = '',
  actorUsername = '',
  role = '',
  permissions = null,
} = {}) {
  const accessDecision = getManagerAccessDecision({ role, permissions });
  if (!accessDecision.allowed) {
    return {
      ok: false,
      reason: 'forbidden',
      error: 'manager-agent requires admin role or write permissions',
      accessVia: accessDecision.via,
    };
  }

  const normalizedAction = normalizeAction(action);
  const actor = String(actorUsername || actorUserId || 'manager_agent').trim();

  if (normalizedAction === 'create_user') {
    const firstName = String(payload?.firstName || '').trim();
    const lastName = String(payload?.lastName || '').trim();
    const username = String(payload?.username || '').trim().toLowerCase();
    const password = String(payload?.password || '').trim();
    const passwordHash = String(payload?.passwordHash || '').trim() || (password ? hashPassword(password) : '');

    if (!firstName || !lastName || !username || !passwordHash) {
      return {
        ok: false,
        reason: 'missing-fields',
        required: ['firstName', 'lastName', 'username', 'password|passwordHash'],
      };
    }

    const userId = String(payload?.userId || `user_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`).trim();
    const user = await createManagedUser({
      userId,
      firstName,
      lastName,
      username,
      passwordHash,
      grantedBy: actor,
    });

    if (!user) {
      return { ok: false, reason: 'create-failed' };
    }

    invalidateUserPermissionCache(user.user_id);
    await auditLoginAttempt({
      userId: user.user_id,
      username: user.username,
      loginSuccess: false,
      failureReason: 'account-created',
    });

    return {
      ok: true,
      action: normalizedAction,
      accessVia: accessDecision.via,
      user: {
        id: user.id,
        userId: user.user_id,
        firstName: user.first_name,
        lastName: user.last_name,
        username: user.username,
        isActive: user.is_active,
        createdAt: user.created_at,
      },
    };
  }

  if (normalizedAction === 'delete_user') {
    const userId = String(payload?.userId || '').trim();
    const username = String(payload?.username || '').trim();
    if (!userId && !username) {
      return {
        ok: false,
        reason: 'missing-identifier',
        note: 'provide userId or username',
      };
    }

    const deletedUser = await deleteManagedUser({
      userId,
      username,
      deletedBy: actor,
    });

    if (!deletedUser) {
      return {
        ok: false,
        reason: 'user-not-found',
        searched: { userId, username },
      };
    }

    invalidateUserPermissionCache(deletedUser.user_id);
    await logQueryExecution({
      actorUsername: actor,
      agentName: 'manager_agent',
      routeName: 'users.delete',
      sqlCommand: 'UPDATE',
      sqlText: `UPDATE users SET is_active=FALSE WHERE user_id='${deletedUser.user_id}'`,
      poolName: 'write',
      success: true,
      rowCount: 1,
    });

    return {
      ok: true,
      action: normalizedAction,
      accessVia: accessDecision.via,
      deletedUser: {
        id: deletedUser.id,
        userId: deletedUser.user_id,
        username: deletedUser.username,
        isActive: deletedUser.is_active,
        updatedAt: deletedUser.updated_at,
      },
    };
  }

  if (normalizedAction === 'activate_user') {
    const userId = String(payload?.userId || '').trim();
    const username = String(payload?.username || '').trim();
    if (!userId && !username) {
      return {
        ok: false,
        reason: 'missing-identifier',
        note: 'provide userId or username',
      };
    }

    const activatedUser = await activateManagedUser({
      userId,
      username,
      activatedBy: actor,
    });

    if (!activatedUser) {
      return {
        ok: false,
        reason: 'user-not-found',
        searched: { userId, username },
      };
    }

    invalidateUserPermissionCache(activatedUser.user_id);
    await logQueryExecution({
      actorUsername: actor,
      agentName: 'manager_agent',
      routeName: 'users.activate',
      sqlCommand: 'UPDATE',
      sqlText: `UPDATE users SET is_active=TRUE WHERE user_id='${activatedUser.user_id}'`,
      poolName: 'write',
      success: true,
      rowCount: 1,
    });

    return {
      ok: true,
      action: normalizedAction,
      accessVia: accessDecision.via,
      activatedUser: {
        id: activatedUser.id,
        userId: activatedUser.user_id,
        username: activatedUser.username,
        isActive: activatedUser.is_active,
        updatedAt: activatedUser.updated_at,
      },
    };
  }

  if (normalizedAction === 'deactivate_user') {
    const userId = String(payload?.userId || '').trim();
    const username = String(payload?.username || '').trim();
    if (!userId && !username) {
      return {
        ok: false,
        reason: 'missing-identifier',
        note: 'provide userId or username',
      };
    }

    const deactivatedUser = await deleteManagedUser({
      userId,
      username,
      deletedBy: actor,
    });

    if (!deactivatedUser) {
      return {
        ok: false,
        reason: 'user-not-found',
        searched: { userId, username },
      };
    }

    invalidateUserPermissionCache(deactivatedUser.user_id);
    await logQueryExecution({
      actorUsername: actor,
      agentName: 'manager_agent',
      routeName: 'users.deactivate',
      sqlCommand: 'UPDATE',
      sqlText: `UPDATE users SET is_active=FALSE WHERE user_id='${deactivatedUser.user_id}'`,
      poolName: 'write',
      success: true,
      rowCount: 1,
    });

    return {
      ok: true,
      action: normalizedAction,
      accessVia: accessDecision.via,
      deactivatedUser: {
        id: deactivatedUser.id,
        userId: deactivatedUser.user_id,
        username: deactivatedUser.username,
        isActive: deactivatedUser.is_active,
        updatedAt: deactivatedUser.updated_at,
      },
    };
  }

  if (normalizedAction === 'assign_permission') {
    const userId = String(payload?.userId || '').trim();
    const permissionCode = String(payload?.permissionCode || '').trim();

    if (!userId || !permissionCode) {
      return {
        ok: false,
        reason: 'missing-fields',
        required: ['userId', 'permissionCode'],
      };
    }

    const assignment = await assignPermissionToUser({
      userId,
      permissionCode,
      grantedBy: actor,
    });

    if (!assignment) {
      return {
        ok: false,
        reason: 'assignment-failed',
        note: 'user or permission not found',
      };
    }

    invalidateUserPermissionCache(userId);
    await logQueryExecution({
      actorUsername: actor,
      agentName: 'manager_agent',
      routeName: 'permissions.assign',
      sqlCommand: 'INSERT',
      sqlText: 'INSERT INTO user_permissions(user_id,permission_id,granted_by) VALUES (...)',
      poolName: 'write',
      success: true,
      rowCount: 1,
    });

    return {
      ok: true,
      action: normalizedAction,
      accessVia: accessDecision.via,
      assignment: {
        userId: assignment.user_id,
        permissionId: assignment.permission_id,
        grantedBy: assignment.granted_by,
        grantedAt: assignment.granted_at,
      },
    };
  }

  return {
    ok: false,
    reason: 'unsupported-action',
    accessVia: accessDecision.via,
    supportedActions: ['create_user', 'delete_user', 'activate_user', 'deactivate_user', 'assign_permission'],
  };
}
