const MAX_SYSTEM_PROMPT_LEN = Math.max(256, Number(process.env.MAX_USER_SYSTEM_PROMPT_LENGTH || '1200'));
const ALLOW_UNTRUSTED_SYSTEM_PROMPT = String(process.env.ALLOW_UNTRUSTED_SYSTEM_PROMPT || 'false').toLowerCase() === 'true';

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all|any|previous|above)\s+instructions?/i,
  /(reveal|show|print|leak)\s+.*(system\s*prompt|hidden\s*prompt|developer\s*message)/i,
  /\b(jailbreak|dan\s+mode|developer\s+mode)\b/i,
  /<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|assistant\|>/i,
  /(?:^|\s)system\s*:\s*/i,
];

const SQL_FORBIDDEN_KEYWORDS = [
  'drop',
  'alter',
  'truncate',
  'create',
  'grant',
  'revoke',
  'execute',
  'do',
  'call',
  'copy',
];

function toText(value) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim();
}

function hasNonTrailingSemicolon(sql) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (!inDouble && ch === "'") {
      if (inSingle && next === "'") {
        i += 1;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && ch === ';') {
      const remainder = sql.slice(i + 1).trim();
      if (remainder.length > 0) return true;
    }
  }
  return false;
}

export function sanitizeUserSystemPrompt(input, { source = 'unknown' } = {}) {
  const raw = toText(input);
  if (!raw) {
    return {
      source,
      value: '',
      ignored: false,
      rejected: false,
      reason: null,
      truncated: false,
    };
  }

  if (!ALLOW_UNTRUSTED_SYSTEM_PROMPT) {
    return {
      source,
      value: '',
      ignored: true,
      rejected: false,
      reason: 'user-system-prompt-disabled',
      truncated: false,
    };
  }

  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(raw)) {
      return {
        source,
        value: '',
        ignored: false,
        rejected: true,
        reason: 'prompt-injection-pattern-detected',
        truncated: false,
      };
    }
  }

  const clipped = raw.slice(0, MAX_SYSTEM_PROMPT_LEN);
  return {
    source,
    value: clipped,
    ignored: false,
    rejected: false,
    reason: null,
    truncated: clipped.length < raw.length,
  };
}

export function validateSqlMutationStatement(inputSql) {
  const sql = toText(inputSql);
  if (!sql) {
    throw new Error('Mutation SQL is required');
  }

  if (sql.length > 10000) {
    throw new Error('Mutation SQL exceeds max length');
  }

  if (/--|\/\*/.test(sql)) {
    throw new Error('SQL comments are not allowed in mutation statements');
  }

  if (hasNonTrailingSemicolon(sql)) {
    throw new Error('Only one SQL statement is allowed');
  }

  const normalized = sql.endsWith(';') ? sql.slice(0, -1).trim() : sql;
  if (!/^(INSERT|UPDATE|DELETE)\b/i.test(normalized)) {
    throw new Error('sql_action only allows INSERT/UPDATE/DELETE');
  }

  for (const keyword of SQL_FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`, 'i');
    if (re.test(normalized)) {
      throw new Error(`Forbidden SQL keyword in mutation statement: ${keyword}`);
    }
  }

  return normalized;
}
