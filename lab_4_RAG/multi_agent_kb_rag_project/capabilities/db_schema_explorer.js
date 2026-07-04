// DB schema explorer
// Queries schema information dynamically from the configured database client.

module.exports = async function dbSchemaExplorerSkill(params, context) {
  if (!context.dbClient) throw new Error('No DB client available');
  return context.dbClient.getSchema(params);
};