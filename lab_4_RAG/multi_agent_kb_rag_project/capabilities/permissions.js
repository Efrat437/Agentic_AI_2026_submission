// Permissions helper
// Checks tool-level access within the application capability layer.

module.exports = async function permissionSkill(toolName, context) {
  if (!context.user || !context.permissions) return false;
  return context.permissions[context.user.id]?.includes(toolName);
};