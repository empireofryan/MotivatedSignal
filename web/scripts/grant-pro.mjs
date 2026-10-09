#!/usr/bin/env node
// Create/reactivate a Pro customer (or revoke one) directly in Turso, and print the access link.
//
// Usage:
//   node web/scripts/grant-pro.mjs <email> [name]
//   node web/scripts/grant-pro.mjs --revoke <email>
//
// Reads TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from web/.env.local (same pattern as
// web/scripts/migrate-actions.mjs). This is the CLI sibling of POST /api/admin/grant.
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import crypto from 'crypto';
import { createClient } from '@libsql/client';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env.local');

const envVars = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  envVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
}

function usage() {
  console.error('Usage: node web/scripts/grant-pro.mjs <email> [name]');
  console.error('       node web/scripts/grant-pro.mjs --revoke <email>');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

const db = createClient({
  url: envVars.TURSO_DATABASE_URL,
  authToken: envVars.TURSO_AUTH_TOKEN,
});

await db.execute(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

const SITE = 'https://motivatedsignal.com';

async function main() {
  if (args[0] === '--revoke') {
    const email = (args[1] ?? '').trim().toLowerCase();
    if (!email) usage();
    const existing = await db.execute({ sql: 'SELECT id FROM customers WHERE email = ?', args: [email] });
    if (existing.rows.length === 0) {
      console.error(`No customer found for ${email}`);
      process.exitCode = 1;
      return;
    }
    await db.execute({
      sql: "UPDATE customers SET status = 'canceled', updated_at = datetime('now') WHERE email = ?",
      args: [email],
    });
    console.log(`Revoked access for ${email}`);
    return;
  }

  const email = (args[0] ?? '').trim().toLowerCase();
  const name = args[1] ?? null;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) usage();

  const existing = await db.execute({ sql: 'SELECT id, key FROM customers WHERE email = ?', args: [email] });
  let key;
  if (existing.rows.length > 0) {
    key = String(existing.rows[0].key);
    await db.execute({
      sql: "UPDATE customers SET status = 'active', name = COALESCE(?, name), updated_at = datetime('now') WHERE email = ?",
      args: [name, email],
    });
    console.log(`Reactivated existing customer ${email}`);
  } else {
    key = crypto.randomBytes(16).toString('hex');
    await db.execute({
      sql: 'INSERT INTO customers (email, name, key, status) VALUES (?, ?, ?, ?)',
      args: [email, name, key, 'active'],
    });
    console.log(`Created customer ${email}`);
  }

  console.log(`${SITE}/api/pro?key=${key}`);
}

await main();
