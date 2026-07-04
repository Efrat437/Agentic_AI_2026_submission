// wait-for-db.js
import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 2000;

const config = {
  user: process.env.DB_USER || 'sso_user',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'sso_db',
  password: process.env.DB_PASSWORD || 'sso_pass',
  port: parseInt(process.env.DB_PORT || '5433', 10),
  connectionTimeoutMillis: 2000,
};

async function waitForDb() {
  let retries = 0;
  while (retries < MAX_RETRIES) {
    try {
      const pool = new Pool(config);
      await pool.query('SELECT 1');
      await pool.end();
      console.log('Database is ready!');
      process.exit(0);
    } catch (err) {
      retries++;
      console.log(`Waiting for database... (${retries}/${MAX_RETRIES})`);
      await new Promise(res => setTimeout(res, RETRY_DELAY_MS));
    }
  }
  console.error('Database not available after waiting. Exiting.');
  process.exit(1);
}

waitForDb();
