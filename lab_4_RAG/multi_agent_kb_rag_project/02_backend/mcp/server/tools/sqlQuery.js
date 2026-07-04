import { runSqlTool } from '../../../agents/sqlTool.js';
import { runSecureAgentSqlFlow } from '../../../security/secure_sql_orchestrator.js';
import { sanitizeUserSystemPrompt } from '../../../security/input_guards.js';

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function mapSecureSqlResultToSqlQueryResult(secureResult = {}, query = '') {
  const generatedSql = String(secureResult?.generated?.sql || '').trim();
  const fields = Array.isArray(secureResult?.result?.fields) ? secureResult.result.fields : [];
  const rows = Array.isArray(secureResult?.result?.rows) ? secureResult.result.rows : [];
  const mappedRows = rows.map((row) => {
    if (!Array.isArray(row)) return row;
    const mapped = {};
    for (let i = 0; i < fields.length; i += 1) {
      mapped[fields[i]] = row[i];
    }
    return mapped;
  });

  return {
    sql: generatedSql,
    rows: mappedRows,
    answer: `Secure SQL flow executed via ${String(secureResult?.selectedAgent || 'unknown-agent')}`,
    meta: {
      query,
      selectedAgent: secureResult?.selectedAgent || null,
      poolName: secureResult?.poolName || null,
      rowCount: Number(secureResult?.result?.rowCount || mappedRows.length || 0),
    },
  };
}

export async function sqlQuery(query, userId = null, sqlOptions = {}, systemPrompt = '', securityContext = null) {
  const timeoutMs = Number(process.env.MCP_SQL_TIMEOUT_MS || '60000');
  try {
    if (securityContext?.userPermissions && securityContext?.jwtUser) {
      const secureResult = await withTimeout(
        runSecureAgentSqlFlow({
          userRequest: query,
          jwtUser: securityContext.jwtUser,
          userPermissions: securityContext.userPermissions,
          requestedAgent: securityContext.requestedAgent || '',
          permissionKey: securityContext.permissionKey || '',
        }),
        timeoutMs,
        'sql_query_secure',
      );

      if (!secureResult?.ok) {
        return {
          sql: null,
          rows: [],
          answer: 'Structured SQL retrieval was denied by security policy.',
          degraded: true,
          error: String(secureResult?.guard?.reason || 'secure-sql-denied'),
        };
      }

      return mapSecureSqlResultToSqlQueryResult(secureResult, query);
    }
    const promptDecision = sanitizeUserSystemPrompt(systemPrompt, { source: 'mcp:sql_query' });
    if (promptDecision.rejected) {
      throw new Error(`Rejected unsafe systemPrompt: ${promptDecision.reason}`);
    }

    return await withTimeout(runSqlTool({ userQuery: query, userId, sqlOptions, systemPrompt: promptDecision.value }), timeoutMs, 'sql_query');
  } catch (err) {
    return {
      sql: null,
      rows: [],
      answer: 'Structured SQL retrieval is temporarily unavailable. Please try again in a moment.',
      degraded: true,
      error: err.message,
    };
  }
}
