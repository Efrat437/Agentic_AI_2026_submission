process.env.BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || 'http://127.0.0.1:3000';
console.log('[ui-proxy] BACKEND_BASE_URL=', process.env.BACKEND_BASE_URL);

await import('./start_ui_server.js');
