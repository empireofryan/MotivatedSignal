import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import os from 'os';

// On Vercel there is no ~/.postgresql/root.crt — the CA pem ships via env var.
const ca =
  process.env.CRDB_CA_CERT ??
  fs.readFileSync(path.join(os.homedir(), '.postgresql/root.crt'), 'utf8');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { ca, rejectUnauthorized: true },
  max: 5,
});

export function query(text: string, params?: unknown[]) {
  return pool.query(text, params);
}

export default pool;
