/**
 * Turso (libsql) access for the `prospects` table — outreach targets for cold email.
 *
 * Credentials come from process.env.TURSO_DATABASE_URL / TURSO_AUTH_TOKEN when set
 * (CI/GitHub Actions sets these from repo secrets), otherwise fall back to parsing
 * web/.env.local, which is where this project's Turso creds live locally
 * (pipeline/.env only has DATABASE_URL for CockroachDB).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ENV_PATH = path.resolve(__dirname, '../../web/.env.local');

function readWebEnv() {
  const text = fs.readFileSync(WEB_ENV_PATH, 'utf8');
  const env = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

let client;

export function prospectsDb() {
  if (!client) {
    // Prefer env vars (CI sets these from repo secrets) so we never touch the
    // filesystem when they're already present — web/.env.local doesn't exist on CI.
    let url = process.env.TURSO_DATABASE_URL;
    let authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      const env = readWebEnv();
      url = env.TURSO_DATABASE_URL;
      authToken = authToken || env.TURSO_AUTH_TOKEN;
    }
    if (!url) throw new Error(`TURSO_DATABASE_URL not found in env or ${WEB_ENV_PATH}`);
    client = createClient({ url, authToken });
  }
  return client;
}

/** Add nullable `zips`/`cities` columns if they don't already exist. Safe to re-run. */
export async function ensureProspectColumns(db = prospectsDb()) {
  const { rows } = await db.execute('PRAGMA table_info(prospects)');
  const cols = new Set(rows.map((r) => r.name));
  if (!cols.has('zips')) {
    await db.execute('ALTER TABLE prospects ADD COLUMN zips TEXT');
  }
  if (!cols.has('cities')) {
    await db.execute('ALTER TABLE prospects ADD COLUMN cities TEXT');
  }
}

// Matches "<City Name>, AZ 85016" style fragments embedded in free-text notes,
// e.g. "Office: 2410 E Osborn Rd Ste 200, Phoenix, AZ 85016". Restricted to AZ
// addresses since this platform only matches against Maricopa County leads —
// an out-of-state HQ address (e.g. "Columbus, OH 43220") is real but useless
// for zip/city matching, so we deliberately leave those null rather than
// inventing geography that doesn't help the match.
const ADDRESS_RE = /,\s*([A-Za-z][A-Za-z .]+?),\s*([A-Z]{2})\s+(\d{5})\b/;

/** Extract {city, zip} from an explicit "City, AZ 12345" fragment in notes, or null. */
export function extractAddressFromNotes(notes) {
  if (!notes) return null;
  const m = String(notes).match(ADDRESS_RE);
  if (!m) return null;
  const [, city, state, zip] = m;
  if (state !== 'AZ') return null;
  return { city: city.trim(), zip };
}

/**
 * Populate zips/cities for every prospect whose notes contain an explicit AZ
 * street address, from the address's own city/zip. Never invents data —
 * prospects without a matching address are left untouched (null).
 * Idempotent: recomputes the same value every run.
 */
export async function populateZipsFromNotes(db = prospectsDb()) {
  const { rows } = await db.execute('SELECT id, notes FROM prospects');
  let updated = 0;
  for (const row of rows) {
    const addr = extractAddressFromNotes(row.notes);
    if (!addr) continue;
    await db.execute({
      sql: 'UPDATE prospects SET zips = ?, cities = ? WHERE id = ?',
      args: [addr.zip, addr.city, row.id],
    });
    updated++;
  }
  return updated;
}

/**
 * `prospect_matches`: the per-prospect lead matches from match-leads.js, persisted so the
 * Vercel send sheet (which cannot read pipeline/outreach/*.json off disk) can render them into
 * Email A. One row per (prospect, match_date, rank 1|2). Re-running match-leads.js on the same
 * Phoenix day upserts in place (fresher pitch lines replace the morning's, never duplicate rows).
 */
export async function ensureProspectMatchesTable(db = prospectsDb()) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS prospect_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prospect_id INTEGER NOT NULL,
      match_date TEXT NOT NULL,
      rank INTEGER NOT NULL,
      apn TEXT,
      pitch_line TEXT,
      match_tier TEXT,
      owner_name TEXT,
      situs_address TEXT,
      situs_city TEXT,
      situs_zip TEXT,
      signal_types TEXT,
      event_date TEXT,
      est_auction_date TEXT,
      assessed_value REAL,
      years_owned INTEGER,
      absentee INTEGER,
      mailing_address TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (prospect_id, match_date, rank)
    )
  `);
}

/** Upsert prospect_matches rows (shape: match-leads.js's `toMatchRow()`). Returns rows written. */
export async function upsertProspectMatches(rows, db = prospectsDb()) {
  if (!rows.length) return 0;
  const stmts = rows.map((r) => ({
    sql: `INSERT INTO prospect_matches
            (prospect_id, match_date, rank, apn, pitch_line, match_tier, owner_name, situs_address,
             situs_city, situs_zip, signal_types, event_date, est_auction_date, assessed_value,
             years_owned, absentee, mailing_address)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (prospect_id, match_date, rank) DO UPDATE SET
            apn = excluded.apn,
            pitch_line = excluded.pitch_line,
            match_tier = excluded.match_tier,
            owner_name = excluded.owner_name,
            situs_address = excluded.situs_address,
            situs_city = excluded.situs_city,
            situs_zip = excluded.situs_zip,
            signal_types = excluded.signal_types,
            event_date = excluded.event_date,
            est_auction_date = excluded.est_auction_date,
            assessed_value = excluded.assessed_value,
            years_owned = excluded.years_owned,
            absentee = excluded.absentee,
            mailing_address = excluded.mailing_address`,
    args: [
      r.prospect_id,
      r.match_date,
      r.rank,
      r.apn,
      r.pitch_line,
      r.match_tier,
      r.owner_name,
      r.situs_address,
      r.situs_city,
      r.situs_zip,
      r.signal_types,
      r.event_date,
      r.est_auction_date,
      r.assessed_value,
      r.years_owned,
      r.absentee,
      r.mailing_address,
    ],
  }));
  await db.batch(stmts, 'write');
  return rows.length;
}

/** Fetch prospects, optionally filtered by segment and/or id list. */
export async function getProspects({ segment, ids } = {}, db = prospectsDb()) {
  const conditions = [];
  const args = [];
  if (segment) {
    conditions.push('segment = ?');
    args.push(segment);
  }
  if (ids && ids.length) {
    conditions.push(`id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.execute({
    sql: `SELECT id, rank, company, contact_name, segment, email, phone, url, appeared_in, notes, status, zips, cities FROM prospects ${where} ORDER BY rank ASC, id ASC`,
    args,
  });
  return rows;
}
