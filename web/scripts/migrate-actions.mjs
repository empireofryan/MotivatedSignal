import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import os from 'os';
import pg from 'pg';
const { Pool } = pg;

// Compute path relative to script location
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env.local');

// Read env from web/.env.local
const envContent = readFileSync(envPath, 'utf8');
const envVars = {};
for (const line of envContent.split('\n')) {
  const [k, ...rest] = line.split('=');
  if (k && rest.length) envVars[k.trim()] = rest.join('=').trim();
}

const pool = new Pool({
  connectionString: envVars['DATABASE_URL'],
  ssl: {
    ca: readFileSync(join(os.homedir(), '.postgresql/root.crt'), 'utf8'),
    rejectUnauthorized: true,
  },
});

const DDL = `
CREATE TABLE IF NOT EXISTS lead_actions (
  apn        STRING NOT NULL,
  action     STRING NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (apn, action)
)
`;

const client = await pool.connect();
try {
  await client.query(DDL);
  console.log('lead_actions table created (or already exists)');
} finally {
  client.release();
  await pool.end();
}
