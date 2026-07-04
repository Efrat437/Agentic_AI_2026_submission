// MCP Client: wraps HTTP calls to MCP server endpoints
import axios from 'axios';

const BASE_URL = 'http://localhost:5000';

export const MCPClient = {
  async getLastReceipt(id) {
    const params = id ? { id } : {};
    const res = await axios.get(`${BASE_URL}/mcp/receipts/last`, { params });
    return res.data;
  },
  async uploadReceipt(file, userId) {
    const formData = new FormData();
    formData.append('file', file);
    if (userId) formData.append('userId', userId);
    const res = await axios.post(`${BASE_URL}/mcp/receipts/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data;
  },
  async currencyExchange(amount, from = 'USD', to = 'NIS') {
    const res = await axios.post(`${BASE_URL}/mcp/currency-exchange`, { amount, from, to });
    return res.data;
  },
  async querySQL(sql, userId) {
    const res = await axios.post(`${BASE_URL}/mcp/receipts/query-sql`, { sql, userId });
    return res.data;
  },
  async queryRAG(query, userId) {
    const res = await axios.post(`${BASE_URL}/mcp/receipts/query-rag`, { query, userId });
    return res.data;
  },
  async querySQLRAG(userQuery, userId) {
    const res = await axios.post(`${BASE_URL}/mcp/receipts/query-sqlrag`, { userQuery, userId });
    return res.data;
  },
  async queryHybridRAG(userQuery, userId) {
    const res = await axios.post(`${BASE_URL}/mcp/receipts/query-hybridrag`, { userQuery, userId });
    return res.data;
  },
};

// Example CLI usage (node mcp_client.js getLastReceipt)
if (require.main === module) {
  const [,, cmd, ...args] = process.argv;
  (async () => {
    try {
      if (cmd === 'getLastReceipt') {
        const result = await MCPClient.getLastReceipt(args[0]);
        console.log(result);
      } else if (cmd === 'currencyExchange') {
        const [amount, from, to] = args;
        const result = await MCPClient.currencyExchange(Number(amount), from, to);
        console.log(result);
      } else {
        console.log('Usage: node mcp_client.js <getLastReceipt|currencyExchange> [args...]');
      }
    } catch (err) {
      console.error('Error:', err.response?.data || err.message);
    }
  })();
}
