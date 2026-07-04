// Ensures robust JSON parsing and structure validation
export function safeParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export function validateReceiptJSON(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!obj.date || !obj.total || !obj.category) return false;
  return true;
}
