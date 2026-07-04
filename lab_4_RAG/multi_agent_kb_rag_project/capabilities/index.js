// index.js
// Central registry for application capabilities and workflow modules.

const multiToolOrchestrator = require('./multi_tool_orchestrator.js');
const smartAggregator = require('./smart_result_aggregator.js');
const mcpSkill = require('./mcp_adapter.js');
const permissionSkill = require('./permissions.js');
const localGovFlowSkill = require('./local_gov_workflow.js');
const dynamicBookingFlowSkill = require('./dynamic_booking_workflow.js');
const dbSchemaExplorerSkill = require('./db_schema_explorer.js');
const aggregatorSkill = require('./result_aggregator.js');
const evaluatorSkill = require('./answer_evaluator.js');
const postProcessingRouterSkill = require('./post_processing_router.js');

module.exports = {
  multiToolOrchestrator,
  smartAggregator,
  mcpSkill,
  permissionSkill,
  localGovFlowSkill,
  dynamicBookingFlowSkill,
  dbSchemaExplorerSkill,
  aggregatorSkill,
  evaluatorSkill,
  postProcessingRouterSkill,
};