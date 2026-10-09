import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => { console.log('migrated'); return pool.end(); })
    .catch(e => { console.error(e); process.exit(1); });
}
