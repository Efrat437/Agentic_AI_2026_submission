// MCP adapter
// Provides a normalized wrapper for MCP tool calls.

module.exports = async function mcpSkill(toolName, params, context) {
  if (!context.mcpClient || !context.mcpClient[toolName]) {
    throw new Error('MCP tool not available: ' + toolName);
  }
  return context.mcpClient[toolName](params, context);
};