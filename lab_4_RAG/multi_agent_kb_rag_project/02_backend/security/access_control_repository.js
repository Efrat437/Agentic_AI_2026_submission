import { readPool, writePool } from '../config/db.js';

function normalizeUsername(value = '') {
  return String(value || '').trim().toLowerCase();
}

export async function createManagedUser({ userId, firstName, lastName, username, passwordHash, grantedBy = 'system' }) {
  const normalizedUsername = normalizeUsername(username);
  const query = `
    INSERT INTO users (user_id, first_name, last_name, username, password_hash, is_active, updated_at)
    VALUES ($1, $2, $3, $4, $5, TRUE, now())
    ON CONFLICT (user_id)
    DO UPDATE SET
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      username = EXCLUDED.username,
      password_hash = EXCLUDED.password_hash,
      is_active = TRUE,
      updated_at = now()
    RETURNING id, user_id, first_name, last_name, username, is_active, created_at, updated_at
  `;

  const { rows } = await writePool.query(query, [
    String(userId || '').trim(),
    String(firstName || '').trim(),
    String(lastName || '').trim(),
    normalizedUsername,
    String(passwordHash || '').trim(),
  ]);

  const user = rows[0] || null;
  if (user) {
    await logQueryExecution({
      actorUsername: grantedBy,
      agentName: 'agent_manager',
      routeName: 'users.createManagedUser',
      sqlCommand: 'INSERT',
      sqlText: query,
      poolName: 'write',
      success: true,
      rowCount: 1,
    });
  }

  return user;
}

export async function deleteManagedUser({ userId, username, deletedBy = 'system' }) {
  const hasUserId = String(userId || '').trim().length > 0;
  const whereClause = hasUserId ? 'user_id = $1' : 'username = $1';
  const value = hasUserId ? String(userId || '').trim() : normalizeUsername(username);

  const query = `
    UPDATE users
    SET is_active = FALSE,
        updated_at = now()
    WHERE ${whereClause}
    RETURNING id, user_id, username, is_active, updated_at
  `;

  const { rows } = await writePool.query(query, [value]);
  const deletedUser = rows[0] || null;

  await logQueryExecution({
    actorUsername: deletedBy,
    agentName: 'agent_manager',
    routeName: 'users.deleteManagedUser',
    sqlCommand: 'UPDATE',
    sqlText: query,
    poolName: 'write',
    success: Boolean(deletedUser),
    rowCount: deletedUser ? 1 : 0,
    errorMessage: deletedUser ? null : 'user-not-found',
  });

  return deletedUser;
}

export async function activateManagedUser({ userId, username, activatedBy = 'system' }) {
  const hasUserId = String(userId || '').trim().length > 0;
  const whereClause = hasUserId ? 'user_id = $1' : 'username = $1';
  const value = hasUserId ? String(userId || '').trim() : normalizeUsername(username);

  const query = `
    UPDATE users
    SET is_active = TRUE,
        updated_at = now()
    WHERE ${whereClause}
    RETURNING id, user_id, username, is_active, updated_at
  `;

  const { rows } = await writePool.query(query, [value]);
  const activatedUser = rows[0] || null;

  await logQueryExecution({
    actorUsername: activatedBy,
    agentName: 'agent_manager',
    routeName: 'users.activateManagedUser',
    sqlCommand: 'UPDATE',
    sqlText: query,
    poolName: 'write',
    success: Boolean(activatedUser),
    rowCount: activatedUser ? 1 : 0,
    errorMessage: activatedUser ? null : 'user-not-found',
  });

  return activatedUser;
}

export async function assignPermissionToUser({ userId, permissionCode, grantedBy = 'system' }) {
  const query = `
    WITH upserted AS (
      INSERT INTO user_permissions (user_id, permission_id, granted_by)
      SELECT u.id, p.id, $3
      FROM users u
      JOIN permissions p ON p.code = $2
      WHERE u.user_id = $1
      ON CONFLICT (user_id, permission_id)
      DO UPDATE SET granted_by = EXCLUDED.granted_by, granted_at = now()
      RETURNING user_id, permission_id, granted_by, granted_at
    )
    SELECT
      u.user_id AS user_id,
      up.user_id AS internal_user_id,
      up.permission_id,
      up.granted_by,
      up.granted_at
    FROM upserted up
    JOIN users u ON u.id = up.user_id
  `;

  const { rows } = await writePool.query(query, [
    String(userId || '').trim(),
    String(permissionCode || '').trim(),
    String(grantedBy || 'system').trim(),
  ]);

  return rows[0] || null;
}

export async function getUserPermissions({ userId }) {
  const query = `
    SELECT
      u.user_id,
      u.username,
      p.code AS permission_code,
      p.access_scope,
      at.table_name,
      at.can_select,
      at.can_insert,
      at.can_update,
      at.can_delete
    FROM users u
    JOIN user_permissions up ON up.user_id = u.id
    JOIN permissions p ON p.id = up.permission_id
    LEFT JOIN allowed_tables at ON at.permission_id = p.id
    WHERE u.user_id = $1
      AND u.is_active = TRUE
    ORDER BY p.code, at.table_name
  `;

  const { rows } = await readPool.query(query, [String(userId || '').trim()]);
  return rows;
}

export async function logQueryExecution({
  actorUserId = null,
  actorUsername = null,
  agentName = null,
  routeName = null,
  sqlText,
  sqlCommand,
  poolName,
  success,
  rowCount = null,
  durationMs = null,
  errorMessage = null,
}) {
  const query = `
    INSERT INTO query_log (
      actor_user_id,
      actor_username,
      agent_name,
      route_name,
      sql_text,
      sql_command,
      pool_name,
      success,
      row_count,
      duration_ms,
      error_message
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id, request_id, created_at
  `;

  const values = [
    actorUserId,
    actorUsername,
    agentName,
    routeName,
    String(sqlText || '').slice(0, 20000),
    String(sqlCommand || '').toUpperCase(),
    String(poolName || 'read').toLowerCase(),
    Boolean(success),
    rowCount,
    durationMs,
    errorMessage,
  ];

  const { rows } = await writePool.query(query, values);
  return rows[0] || null;
}

export async function auditLoginAttempt({ userId = null, username = null, loginSuccess, failureReason = null, ipAddress = null, userAgent = null }) {
  const query = `
    INSERT INTO audit_login (
      user_id,
      username,
      login_success,
      failure_reason,
      ip_address,
      user_agent
    )
    VALUES (
      (SELECT id FROM users WHERE user_id = $1 LIMIT 1),
      $2,
      $3,
      $4,
      $5,
      $6
    )
    RETURNING id, created_at
  `;

  const { rows } = await writePool.query(query, [
    String(userId || '').trim() || null,
    normalizeUsername(username || ''),
    Boolean(loginSuccess),
    failureReason,
    ipAddress,
    userAgent,
  ]);

  return rows[0] || null;
}

export async function getCurrentMonthLoggedInUsersCount() {
  const query = 'SELECT logged_in_users_current_month FROM vw_logged_in_users_current_month';
  const { rows } = await readPool.query(query);
  return Number(rows?.[0]?.logged_in_users_current_month || 0);
}

export async function createResourceBooking({ resourceKey, resourceName, slotStart, slotEnd, bookedByUserId = null, notes = null }) {
  const query = `
    INSERT INTO resources_booking (
      resource_key,
      resource_name,
      slot_start,
      slot_end,
      status,
      booked_by_user_id,
      notes,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      'booked',
      (SELECT id FROM users WHERE user_id = $5 LIMIT 1),
      $6,
      now()
    )
    RETURNING id, resource_key, resource_name, slot_start, slot_end, status, booking_reference, created_at
  `;

  const { rows } = await writePool.query(query, [
    String(resourceKey || '').trim(),
    String(resourceName || '').trim(),
    slotStart,
    slotEnd,
    String(bookedByUserId || '').trim() || null,
    notes,
  ]);

  return rows[0] || null;
}
