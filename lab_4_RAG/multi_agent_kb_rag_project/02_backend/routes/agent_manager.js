import express from 'express';
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
import { getManagerAccessDecision } from '../agents/manager_agent.js';

const router = express.Router();

router.use((req, res, next) => {
  const role = String(req?.authContext?.jwtUser?.role || req?.headers?.['x-user-role'] || '').trim().toLowerCase();
  const permissions = req?.authContext?.permissions || null;
  const accessDecision = getManagerAccessDecision({ role, permissions });
  if (!accessDecision.allowed) {
    return res.status(403).json({
      ok: false,
      reason: 'forbidden',
      error: 'manager operations require admin role or write permissions',
      accessVia: accessDecision.via,
    });
  }
  req.managerAccessVia = accessDecision.via;
  return next();
});

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password || '')).digest('hex');
}

router.post('/users/create', async (req, res) => {
  try {
    const { firstName, lastName, username, password, createdBy = 'api' } = req.body || {};

    if (!firstName || !lastName || !username || !password) {
      return res.status(400).json({
        ok: false,
        reason: 'missing-fields',
        required: ['firstName', 'lastName', 'username', 'password'],
      });
    }

    const userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const passwordHash = hashPassword(password);

    const user = await createManagedUser({
      userId,
      firstName: String(firstName).trim(),
      lastName: String(lastName).trim(),
      username: String(username).trim().toLowerCase(),
      passwordHash,
      grantedBy: String(createdBy).trim(),
    });

    if (!user) {
      return res.status(500).json({ ok: false, reason: 'create-failed' });
    }

    invalidateUserPermissionCache(user.user_id);

    await auditLoginAttempt({
      userId: user.user_id,
      username: user.username,
      loginSuccess: false,
      failureReason: 'account-created',
    });

    res.status(201).json({
      ok: true,
      user: {
        id: user.id,
        userId: user.user_id,
        firstName: user.first_name,
        lastName: user.last_name,
        username: user.username,
        isActive: user.is_active,
        createdAt: user.created_at,
      },
    });
  } catch (err) {
    console.error('[agent_manager/users/create]', err);
    res.status(500).json({
      ok: false,
      reason: 'server-error',
      error: String(err?.message || err),
    });
  }
});

router.post('/users/delete', async (req, res) => {
  try {
    const { userId, username, deletedBy = 'api' } = req.body || {};

    if (!userId && !username) {
      return res.status(400).json({
        ok: false,
        reason: 'missing-identifier',
        note: 'provide userId or username',
      });
    }

    const deletedUser = await deleteManagedUser({
      userId,
      username,
      deletedBy: String(deletedBy).trim(),
    });

    if (!deletedUser) {
      return res.status(404).json({
        ok: false,
        reason: 'user-not-found',
        searched: { userId, username },
      });
    }

    invalidateUserPermissionCache(deletedUser.user_id);

    await logQueryExecution({
      actorUsername: String(deletedBy).trim(),
      agentName: 'agent_manager',
      routeName: 'users.delete',
      sqlCommand: 'UPDATE',
      sqlText: `UPDATE users SET is_active=FALSE WHERE user_id='${deletedUser.user_id}'`,
      poolName: 'write',
      success: true,
      rowCount: 1,
    });

    res.status(200).json({
      ok: true,
      deletedUser: {
        id: deletedUser.id,
        userId: deletedUser.user_id,
        username: deletedUser.username,
        isActive: deletedUser.is_active,
        updatedAt: deletedUser.updated_at,
      },
    });
  } catch (err) {
    console.error('[agent_manager/users/delete]', err);
    res.status(500).json({
      ok: false,
      reason: 'server-error',
      error: String(err?.message || err),
    });
  }
});

router.post('/users/deactivate', async (req, res) => {
  try {
    const { userId, username, deactivatedBy = 'api' } = req.body || {};

    if (!userId && !username) {
      return res.status(400).json({
        ok: false,
        reason: 'missing-identifier',
        note: 'provide userId or username',
      });
    }

    const deactivatedUser = await deleteManagedUser({
      userId,
      username,
      deletedBy: String(deactivatedBy).trim(),
    });

    if (!deactivatedUser) {
      return res.status(404).json({
        ok: false,
        reason: 'user-not-found',
        searched: { userId, username },
      });
    }

    invalidateUserPermissionCache(deactivatedUser.user_id);

    await logQueryExecution({
      actorUsername: String(deactivatedBy).trim(),
      agentName: 'agent_manager',
      routeName: 'users.deactivate',
      sqlCommand: 'UPDATE',
      sqlText: `UPDATE users SET is_active=FALSE WHERE user_id='${deactivatedUser.user_id}'`,
      poolName: 'write',
      success: true,
      rowCount: 1,
    });

    res.status(200).json({
      ok: true,
      deactivatedUser: {
        id: deactivatedUser.id,
        userId: deactivatedUser.user_id,
        username: deactivatedUser.username,
        isActive: deactivatedUser.is_active,
        updatedAt: deactivatedUser.updated_at,
      },
    });
  } catch (err) {
    console.error('[agent_manager/users/deactivate]', err);
    res.status(500).json({
      ok: false,
      reason: 'server-error',
      error: String(err?.message || err),
    });
  }
});

router.post('/users/activate', async (req, res) => {
  try {
    const { userId, username, activatedBy = 'api' } = req.body || {};

    if (!userId && !username) {
      return res.status(400).json({
        ok: false,
        reason: 'missing-identifier',
        note: 'provide userId or username',
      });
    }

    const activatedUser = await activateManagedUser({
      userId,
      username,
      activatedBy: String(activatedBy).trim(),
    });

    if (!activatedUser) {
      return res.status(404).json({
        ok: false,
        reason: 'user-not-found',
        searched: { userId, username },
      });
    }

    invalidateUserPermissionCache(activatedUser.user_id);

    await logQueryExecution({
      actorUsername: String(activatedBy).trim(),
      agentName: 'agent_manager',
      routeName: 'users.activate',
      sqlCommand: 'UPDATE',
      sqlText: `UPDATE users SET is_active=TRUE WHERE user_id='${activatedUser.user_id}'`,
      poolName: 'write',
      success: true,
      rowCount: 1,
    });

    res.status(200).json({
      ok: true,
      activatedUser: {
        id: activatedUser.id,
        userId: activatedUser.user_id,
        username: activatedUser.username,
        isActive: activatedUser.is_active,
        updatedAt: activatedUser.updated_at,
      },
    });
  } catch (err) {
    console.error('[agent_manager/users/activate]', err);
    res.status(500).json({
      ok: false,
      reason: 'server-error',
      error: String(err?.message || err),
    });
  }
});

router.post('/permissions/assign', async (req, res) => {
  try {
    const { userId, permissionCode, grantedBy = 'api' } = req.body || {};

    if (!userId || !permissionCode) {
      return res.status(400).json({
        ok: false,
        reason: 'missing-fields',
        required: ['userId', 'permissionCode'],
      });
    }

    const assignment = await assignPermissionToUser({
      userId: String(userId).trim(),
      permissionCode: String(permissionCode).trim(),
      grantedBy: String(grantedBy).trim(),
    });

    if (!assignment) {
      return res.status(404).json({
        ok: false,
        reason: 'assignment-failed',
        note: 'user or permission not found',
      });
    }

    invalidateUserPermissionCache(String(userId).trim());

    await logQueryExecution({
      actorUsername: String(grantedBy).trim(),
      agentName: 'agent_manager',
      routeName: 'permissions.assign',
      sqlCommand: 'INSERT',
      sqlText: `INSERT INTO user_permissions(user_id,permission_id,granted_by) VALUES (...)`,
      poolName: 'write',
      success: true,
      rowCount: 1,
    });

    res.status(201).json({
      ok: true,
      assignment: {
        userId: assignment.user_id,
        permissionId: assignment.permission_id,
        grantedBy: assignment.granted_by,
        grantedAt: assignment.granted_at,
      },
    });
  } catch (err) {
    console.error('[agent_manager/permissions/assign]', err);
    res.status(500).json({
      ok: false,
      reason: 'server-error',
      error: String(err?.message || err),
    });
  }
});

export default router;
