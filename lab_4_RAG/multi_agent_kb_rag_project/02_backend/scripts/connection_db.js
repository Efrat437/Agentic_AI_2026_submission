import { Client } from 'pg';

const client = new Client({
  user: 'sso_user',
  host: 'localhost',
  database: 'sso_db',
  password: 'sso_pass',
  port: 5432,
});

await client.connect();

