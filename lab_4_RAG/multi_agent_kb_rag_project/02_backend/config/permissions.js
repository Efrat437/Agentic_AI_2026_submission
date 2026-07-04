import 'dotenv/config';

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const ADMIN_ROLES = (process.env.ADMIN_ROLES || 'admin,supervisor')
  .split(',')
  .map((r) => r.trim().toLowerCase())
  .filter(Boolean);

const BACKEND_API_KEY = process.env.BACKEND_API_KEY || '';
const ENABLE_ACTION_EXECUTION = asBool(process.env.ENABLE_ACTION_EXECUTION, true);
const ALLOW_SQL_MUTATIONS = asBool(process.env.ALLOW_SQL_MUTATIONS, false);
const REQUIRE_ACTION_CONFIRMATION = asBool(process.env.REQUIRE_ACTION_CONFIRMATION, true);

export function getRequestRole(req) {
  return String(req.headers['x-user-role'] || 'anonymous').toLowerCase();
}

export function isAdminRequest(req) {
  const role = getRequestRole(req);
  return ADMIN_ROLES.includes(role);
}

export function enforceApiKey(req, res, next) {
  if (!BACKEND_API_KEY) return next();
  const candidate = req.headers['x-api-key'];
  if (candidate !== BACKEND_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid API key' });
  }
  return next();
}

export function requireAdmin(req, res, next) {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ error: 'Forbidden: admin role required' });
  }
  return next();
}

export function getActionPermissionContext(req, { confirmed = false } = {}) {
  return {
    executionEnabled: ENABLE_ACTION_EXECUTION,
    allowMutations: ALLOW_SQL_MUTATIONS && isAdminRequest(req),
    requireConfirmation: REQUIRE_ACTION_CONFIRMATION,
    confirmed,
  };
}

export const permissionSettings = {
  backendApiKeyEnabled: Boolean(BACKEND_API_KEY),
  actionExecutionEnabled: ENABLE_ACTION_EXECUTION,
  allowSqlMutations: ALLOW_SQL_MUTATIONS,
  requireActionConfirmation: REQUIRE_ACTION_CONFIRMATION,
  adminRoles: ADMIN_ROLES,
};
