import { proposeAction, executeAction } from '../../../agents/action_agent.js';
import { getActionById } from '../../../agents/dbTools.js';
import { permissionSettings } from '../../../config/permissions.js';

function buildPermissionContext({ confirmed = false, allowMutations = false } = {}) {
  return {
    executionEnabled: Boolean(permissionSettings?.actionExecutionEnabled),
    allowMutations: Boolean(permissionSettings?.allowSqlMutations) && Boolean(allowMutations),
    requireConfirmation: Boolean(permissionSettings?.requireActionConfirmation),
    confirmed: Boolean(confirmed),
  };
}

export async function actionPropose({ userQuery, userId = null } = {}) {
  return proposeAction({ userQuery, userId });
}

export async function actionGet({ actionId } = {}) {
  return getActionById(actionId);
}

export async function actionExecute({ actionId, mode = 'auto', userId = null, confirmed = false, allowMutations = false } = {}) {
  const permissions = buildPermissionContext({ confirmed, allowMutations });
  return executeAction({ actionId, mode, permissions, userId });
}
