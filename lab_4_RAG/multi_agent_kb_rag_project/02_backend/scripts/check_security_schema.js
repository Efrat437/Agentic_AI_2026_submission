import pg from 'pg';

const { Client } = pg;

const TABLE_SPECS = {
  users: ['id', 'user_id', 'username', 'password_hash', 'created_at'],
  permissions: ['id', 'code', 'access_scope', 'created_at'],
  user_permissions: ['user_id', 'permission_id', 'granted_at'],
  allowed_tables: ['id', 'permission_id', 'table_name', 'can_select'],
  query_log: ['id', 'actor_user_id', 'agent_name', 'sql_text', 'created_at'],
  audit_login: ['id', 'user_id', 'username', 'login_success', 'created_at'],
  resources_booking: ['id', 'resource_key', 'slot_start', 'slot_end', 'status', 'created_at'],
  government_requests: ['id', 'user_id', 'description', 'status', 'notes', 'created_at'],
  secure_roles: ['role_name', 'description', 'created_at'],
  secure_users: ['user_id', 'role_name', 'active', 'created_at'],
  secure_role_permissions: ['role_name', 'permission_key', 'permission_value'],
  secure_agent_permissions: ['agent_name', 'access_scope', 'allowed_commands', 'allowed_tables'],
  secure_query_logs: ['id', 'user_id', 'agent_name', 'pool_name', 'created_at'],
};

const QUERY_LOG_SIMPLE_SPEC = ['id', 'user_id', 'agent_type', 'query', 'created_at'];
const LEGACY_COMPAT_TABLE_SPECS = {
  users: ['id', 'email', 'role', 'created_at'],
  permissions: ['id', 'code'],
  user_permissions: ['user_id', 'permission_id'],
  query_log: ['id', 'user_id', 'agent_type', 'query', 'created_at'],
  audit_login: ['id', 'user_id', 'success', 'ip_address', 'created_at'],
};

function getConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5433),
    user: process.env.DB_USER || 'sso_user',
    password: process.env.DB_PASSWORD || 'sso_pass',
    database: process.env.DB_NAME || 'sso_db',
  };
}

async function getColumns(client, relName) {
  const r = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [relName],
  );
  return r.rows.map((x) => x.column_name);
}

function checkColumns(actual = [], required = []) {
  const set = new Set(actual);
  const missing = required.filter((c) => !set.has(c));
  return {
    ok: missing.length === 0,
    missing,
  };
}

async function run() {
  const client = new Client(getConfig());
  await client.connect();
  try {
    const tableResults = {};
    for (const [table, requiredCols] of Object.entries(TABLE_SPECS)) {
      const cols = await getColumns(client, table);
      const check = checkColumns(cols, requiredCols);
      tableResults[table] = {
        exists: cols.length > 0,
        requiredOk: check.ok,
        missingRequired: check.missing,
        columns: cols,
      };
    }

    const compatViewCols = await getColumns(client, 'vw_query_log_simple');
    const compatCheck = checkColumns(compatViewCols, QUERY_LOG_SIMPLE_SPEC);

    const legacyCompat = {};
    for (const [table, requiredCols] of Object.entries(LEGACY_COMPAT_TABLE_SPECS)) {
      const cols = await getColumns(client, table);
      const check = checkColumns(cols, requiredCols);
      legacyCompat[table] = {
        ok: check.ok,
        missingRequired: check.missing,
      };
    }

    const output = {
      ok: Object.values(tableResults).every((t) => t.exists && t.requiredOk) && compatCheck.ok,
      db: {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5433),
        database: process.env.DB_NAME || 'sso_db',
      },
      tables: tableResults,
      compatibility: {
        view: 'vw_query_log_simple',
        requiredShape: QUERY_LOG_SIMPLE_SPEC,
        ok: compatCheck.ok,
        missingRequired: compatCheck.missing,
        columns: compatViewCols,
      },
      legacyTableCompatibility: {
        ok: Object.values(legacyCompat).every((x) => x.ok),
        checks: legacyCompat,
      },
    };

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }, null, 2));
  process.exit(1);
});
