import express from 'express';
import { readPool } from '../config/db.js';
import { getCurrentMonthLoggedInUsersCount, logQueryExecution } from '../security/access_control_repository.js';

const router = express.Router();

router.get('/audit/logged-in-users-current-month', async (req, res) => {
  try {
    const { actorUsername = 'api' } = req.query || {};

    const count = await getCurrentMonthLoggedInUsersCount();

    await logQueryExecution({
      actorUsername: String(actorUsername).trim(),
      agentName: 'agent_stats',
      routeName: 'audit.logged-in-users-current-month',
      sqlCommand: 'SELECT',
      sqlText: `SELECT COUNT(DISTINCT COALESCE(user_id::TEXT, username)) FROM audit_login
                WHERE login_success=TRUE AND created_at >= date_trunc('month', now())`,
      poolName: 'read',
      success: true,
      rowCount: 1,
    });

    res.status(200).json({
      ok: true,
      stat: 'logged_in_users_current_month',
      result: {
        count,
        fromDateStr: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
        toDateStr: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[agent_stats/audit/logged-in-users-current-month]', err);

    await logQueryExecution({
      actorUsername: 'api',
      agentName: 'agent_stats',
      routeName: 'audit.logged-in-users-current-month',
      sqlCommand: 'SELECT',
      sqlText: 'SELECT ... FROM audit_login',
      poolName: 'read',
      success: false,
      errorMessage: String(err?.message || err),
    }).catch(() => {});

    res.status(500).json({
      ok: false,
      reason: 'server-error',
      error: String(err?.message || err),
    });
  }
});

router.get('/audit/summary', async (req, res) => {
  try {
    const { actorUsername = 'api', days = 30 } = req.query || {};
    const boundedDays = Math.max(1, Math.min(365, Number(days)));

    const query = `
      SELECT
        login_success,
        COUNT(*) AS attempts,
        COUNT(DISTINCT COALESCE(user_id::TEXT, username)) AS unique_users
      FROM audit_login
      WHERE created_at >= now() - (INTERVAL '1 day' * $1)
      GROUP BY login_success
      ORDER BY login_success DESC
    `;

    const { rows } = await readPool.query(query, [boundedDays]);

    await logQueryExecution({
      actorUsername: String(actorUsername).trim(),
      agentName: 'agent_stats',
      routeName: 'audit.summary',
      sqlCommand: 'SELECT',
      sqlText: query,
      poolName: 'read',
      success: true,
      rowCount: rows.length,
    });

    res.status(200).json({
      ok: true,
      stat: 'audit_summary',
      days: boundedDays,
      results: rows.map((row) => ({
        loginSuccess: row.login_success,
        totalAttempts: Number(row.attempts),
        uniqueUsers: Number(row.unique_users),
      })),
    });
  } catch (err) {
    console.error('[agent_stats/audit/summary]', err);

    await logQueryExecution({
      actorUsername: 'api',
      agentName: 'agent_stats',
      routeName: 'audit.summary',
      sqlCommand: 'SELECT',
      sqlText: 'SELECT ... FROM audit_login',
      poolName: 'read',
      success: false,
      errorMessage: String(err?.message || err),
    }).catch(() => {});

    res.status(500).json({
      ok: false,
      reason: 'server-error',
      error: String(err?.message || err),
    });
  }
});

router.get('/query-log/summary', async (req, res) => {
  try {
    const { actorUsername = 'api', limit = 100 } = req.query || {};
    const boundedLimit = Math.max(1, Math.min(1000, Number(limit)));

    const query = `
      SELECT
        pool_name,
        sql_command,
        COUNT(*) AS total,
        SUM(CASE WHEN success THEN 1 ELSE 0 END) AS succeeded,
        AVG(duration_ms)::INTEGER AS avg_duration_ms
      FROM query_log
      WHERE created_at >= now() - INTERVAL '24 hours'
      GROUP BY pool_name, sql_command
      ORDER BY total DESC
      LIMIT $1
    `;

    const { rows } = await readPool.query(query, [boundedLimit]);

    await logQueryExecution({
      actorUsername: String(actorUsername).trim(),
      agentName: 'agent_stats',
      routeName: 'query-log.summary',
      sqlCommand: 'SELECT',
      sqlText: query,
      poolName: 'read',
      success: true,
      rowCount: rows.length,
    });

    res.status(200).json({
      ok: true,
      stat: 'query_log_summary',
      window: '24h',
      results: rows.map((row) => ({
        poolName: row.pool_name,
        sqlCommand: row.sql_command,
        total: Number(row.total),
        succeeded: Number(row.succeeded),
        failed: Number(row.total) - Number(row.succeeded),
        avgDurationMs: row.avg_duration_ms,
      })),
    });
  } catch (err) {
    console.error('[agent_stats/query-log/summary]', err);

    await logQueryExecution({
      actorUsername: 'api',
      agentName: 'agent_stats',
      routeName: 'query-log.summary',
      sqlCommand: 'SELECT',
      sqlText: 'SELECT ... FROM query_log',
      poolName: 'read',
      success: false,
      errorMessage: String(err?.message || err),
    }).catch(() => {});

    res.status(500).json({
      ok: false,
      reason: 'server-error',
      error: String(err?.message || err),
    });
  }
});

export default router;
