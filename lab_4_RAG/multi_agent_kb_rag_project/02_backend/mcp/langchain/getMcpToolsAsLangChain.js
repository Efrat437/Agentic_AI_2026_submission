import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mcpInputSchemaToZod(jsonSchema) {
  if (!jsonSchema || typeof jsonSchema !== 'object') {
    return z.object({});
  }

  const props = jsonSchema.properties;
  const required = new Set(jsonSchema.required || []);
  if (!props || typeof props !== 'object') {
    return z.object({});
  }

  const shape = {};
  for (const [key, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== 'object') {
      shape[key] = z.any().optional().nullable();
      continue;
    }

    const types = Array.isArray(prop.type) ? prop.type : [prop.type || 'any'];
    const zodCandidates = [];
    for (const t of types) {
      switch (t) {
        case 'string':
          zodCandidates.push(z.string());
          break;
        case 'number':
        case 'integer':
          zodCandidates.push(z.number());
          break;
        case 'boolean':
          zodCandidates.push(z.boolean());
          break;
        case 'array':
          zodCandidates.push(z.array(z.union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.any())])));
          break;
        case 'object':
          zodCandidates.push(z.record(z.any()));
          break;
        case 'null':
          zodCandidates.push(z.null());
          break;
        default:
          zodCandidates.push(z.any());
      }
    }

    let field = zodCandidates.length > 1 ? z.union(zodCandidates) : zodCandidates[0];
    if (!required.has(key)) {
      field = field.optional().nullable();
    }
    shape[key] = field;
  }

  return z.object(shape).passthrough();
}

// Build LangChain tools from an MCP-like client with listTools() and callTool({name, arguments}).
export async function getMcpToolsAsLangChain(mcpClient) {
  const { tools } = await mcpClient.listTools();
  const list = Array.isArray(tools) ? tools : [];
  const generatedTools = list.map((t) => {
    const name = String(t?.name || 'unknown_tool');
    const description = t?.description || `Call MCP tool: ${name}`;
    const schema = mcpInputSchemaToZod(t?.inputSchema);

    return new DynamicStructuredTool({
      name,
      description,
      schema,
      func: async (args) => {
        const result = await mcpClient.callTool({ name, arguments: args || {} });
        const texts = (result?.content || [])
          .filter((c) => c?.type === 'text')
          .map((c) => c?.text)
          .filter(Boolean);

        if (texts.length > 0) {
          const combined = texts.join('\n');
          return safeJsonParse(combined) || combined;
        }

        return result;
      },
    });
  });

  const hasAgentManagerTool = generatedTools.some((t) => String(t?.name || '') === 'agent_manager');
  if (!hasAgentManagerTool) {
    const createUser = async (input) => {
      const result = await mcpClient.callTool({
        name: 'agent_manager',
        arguments: {
          action: 'create_user',
          firstName: input?.firstName,
          lastName: input?.lastName,
          password: input?.password,
        },
      });
      const texts = (result?.content || [])
        .filter((c) => c?.type === 'text')
        .map((c) => c?.text)
        .filter(Boolean);
      const combined = texts.join('\n');
      return safeJsonParse(combined) || combined || result;
    };

    const deleteUser = async (userId) => {
      const result = await mcpClient.callTool({
        name: 'agent_manager',
        arguments: {
          action: 'delete_user',
          userId,
        },
      });
      const texts = (result?.content || [])
        .filter((c) => c?.type === 'text')
        .map((c) => c?.text)
        .filter(Boolean);
      const combined = texts.join('\n');
      return safeJsonParse(combined) || combined || result;
    };

    const agentManagerTool = new DynamicStructuredTool({
      name: 'agent_manager',
      description: 'Create or delete users via manager operations.',
      schema: z.object({
        action: z.enum(['create_user', 'delete_user']),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        password: z.string().optional(),
        userId: z.number().optional(),
      }),
      func: async (input) => {
        if (input.action === 'create_user') {
          return createUser(input);
        }
        if (input.action === 'delete_user') {
          return deleteUser(input.userId);
        }
        return { ok: false, error: 'unsupported-action' };
      },
    });

    generatedTools.push(agentManagerTool);
  }

  return generatedTools;
}
