import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

// In CI (GitHub Actions) there is no ~/.postgresql/root.crt — the CA pem ships via env var.
// Mirrors web/lib/db.ts, which does the same for Vercel.
const ca =
  process.env.CRDB_CA_CERT ??
  fs.readFileSync(path.join(os.homedir(), '.postgresql/root.crt'), 'utf8');

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { ca, rejectUnauthorized: true },
  max: 5,
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
