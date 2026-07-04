import { getMcpToolsAsLangChain } from './getMcpToolsAsLangChain.js';
import { RestMcpClientAdapter } from './restMcpClient.js';

export async function createLangchainMcpInvoker() {
  const mcpClient = new RestMcpClientAdapter();
  const tools = await getMcpToolsAsLangChain(mcpClient);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  return async function invokeLangchainMcpTool(name, args = {}) {
    const tool = toolMap.get(name);
    if (!tool) {
      throw new Error(`LangChain MCP tool not found: ${name}`);
    }
    return tool.invoke(args || {});
  };
}
