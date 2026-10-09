# Motivated Sellers Pipeline (Phases 1–3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Maricopa County ingest pipeline that populates a CockroachDB database with the Assessor parcel spine plus distress signals (tax-delinquent, code violations, Notice of Trustee's Sale, probate), so we have a real, queryable distressed-property dataset.

**Architecture:** A Node ESM pipeline. Each data source is an *adapter* exposing a common `fetch()` interface and emitting `NormalizedRecord[]`. A runner upserts records into `signals` (idempotent on `(source, external_id)`) and logs `scrape_runs`. The Assessor adapter is special: it populates the `properties` spine that every other signal resolves against (by APN, or later by owner-name/address). Open-data sources use `fetch`; the three "moat" sources (Recorder, Court, Phoenix code) use Playwright.

**Tech Stack:** Node 22 (ESM), `pg` (CockroachDB), Playwright (scrapers), `node:test` (tests), `dotenv`. No external test runner, no LLM SDKs, no Google APIs.

## Global Constraints

- **DB:** CockroachDB cluster `norbound-1`, database `motivated_sellers`. Connection string in `pipeline/.env` as `DATABASE_URL`. SSL uses CA at `~/.postgresql/root.crt`.
- **No direct LLM/Anthropic API calls; no `@anthropic-ai/sdk`, `openai`, etc.** All LLM-assisted normalization happens later via the Claude Code routine, not in adapter code.
- **No paid Google APIs.**
- **Scraping:** Playwright only (JS-rendering). Extract from structured tables / explicit selectors / JSON — **never `innerText` regex fallback**. Throttle scrapers ≥1 request/sec. Court docket: respect robots.txt disallow on `/Docket/` by throttling and limiting volume.
- **Idempotency:** every signal upsert keyed on `UNIQUE (source, external_id)`. Re-runs must not duplicate rows.
- **Never delete signals.** Status changes update in place; `raw` JSONB always retained.
- **APN normalization:** strip dashes/spaces, uppercase — one canonical form everywhere (`normalizeApn`).
- **Skip-trace stays disabled** (`SKIPTRACE_ENABLED=false`); not in scope for these phases.
- **Tests use fixtures** committed under `pipeline/test/fixtures/`. Probe scripts fetch live data to *create* fixtures; unit tests never hit the network.

---

## File Structure

```
pipeline/
  package.json                 # scripts: ingest, test, probe
  .env                         # DATABASE_URL (gitignored)
  src/
    db.js                      # pg Pool + query helper + tx helper
    schema.sql                 # DDL for properties, signals, scrape_runs
    migrate.js                 # apply schema.sql
    normalize.js               # normalizeApn, normalizeOwnerName, normalizeAddress
    upsert.js                  # upsertProperties(), upsertSignals(), recordRun()
    run.js                     # adapter runner: loop adapters -> upsert -> log
    arcgis.js                  # generic ArcGIS FeatureServer paged fetch helper
    sources/
      assessor.js              # spine -> properties
      treasurer.js             # tax_delinquent (ArcGIS)
      code_mesa.js             # code_violation (Socrata)
      code_glendale.js         # code_violation (ArcGIS)
      code_tempe.js            # code_violation (ArcGIS)
      code_county.js           # code_violation (ArcGIS, flag staleness)
      code_scottsdale.js       # code_violation (ArcGIS Hub CSV)
      recorder_nots.js         # trustee_sale (Playwright)
      court_probate.js         # probate (Playwright/HTTP)
      phoenix_code.js          # code_violation (Playwright, Accela)
  test/
    fixtures/                  # saved real responses (committed)
    *.test.js                  # node:test unit tests
  scripts/
    probe.js                   # CLI: fetch a live sample from a source, save fixture
```

---

### Task 1: Database connection + schema

**Files:**
- Create: `pipeline/src/db.js`
- Create: `pipeline/src/schema.sql`
- Create: `pipeline/src/migrate.js`
- Test: `pipeline/test/db.test.js`

**Interfaces:**
- Produces: `query(text, params) -> Promise<{rows}>`, `withTx(fn)`, `pool` (from `db.js`). `migrate()` applies `schema.sql`.

- [ ] **Step 1: Write `db.js`**

```js
// pipeline/src/db.js
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const ca = fs.readFileSync(path.join(os.homedir(), '.postgresql/root.crt'), 'utf8');

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
```

- [ ] **Step 2: Write `schema.sql`** (CockroachDB dialect — `gen_random_uuid()` is built in)

```sql
-- pipeline/src/schema.sql
CREATE TABLE IF NOT EXISTS properties (
  apn             STRING PRIMARY KEY,
  situs_address   STRING,
  situs_city      STRING,
  situs_zip       STRING,
  owner_name      STRING,
  owner_name_norm STRING,
  mailing_address STRING,
  absentee        BOOL,
  year_built      INT,
  living_sqft     INT,
  building_type   STRING,
  last_sale_date  DATE,
  last_sale_price DECIMAL,
  assessed_value  DECIMAL,
  legal_class     STRING,
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_properties_owner_norm ON properties (owner_name_norm);

CREATE TABLE IF NOT EXISTS signals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  apn              STRING NULL REFERENCES properties(apn),
  signal_type      STRING NOT NULL,
  source           STRING NOT NULL,
  source_url       STRING,
  external_id      STRING NOT NULL,
  observed_date    DATE DEFAULT current_date(),
  event_date       DATE,
  status           STRING,
  owner_name       STRING,
  situs_address    STRING,
  resolved         BOOL DEFAULT false,
  match_confidence STRING,
  raw              JSONB,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_signals_apn ON signals (apn);
CREATE INDEX IF NOT EXISTS idx_signals_type ON signals (signal_type);
CREATE INDEX IF NOT EXISTS idx_signals_unresolved ON signals (resolved) WHERE resolved = false;

CREATE TABLE IF NOT EXISTS scrape_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source          STRING NOT NULL,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  rows_found      INT,
  rows_new        INT,
  status          STRING,
  error           STRING,
  source_max_date DATE
);
```

- [ ] **Step 3: Write `migrate.js`**

```js
// pipeline/src/migrate.js
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
```

- [ ] **Step 4: Add scripts to `package.json`**

```json
{
  "scripts": {
    "migrate": "node src/migrate.js",
    "ingest": "node src/run.js",
    "probe": "node scripts/probe.js",
    "test": "node --test"
  }
}
```

- [ ] **Step 5: Write the test**

```js
// pipeline/test/db.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../src/migrate.js';
import { query, pool } from '../src/db.js';

test('migrate creates tables and they are queryable', async () => {
  await migrate();
  for (const t of ['properties', 'signals', 'scrape_runs']) {
    const r = await query(`SELECT count(*) FROM ${t}`);
    assert.ok(Number(r.rows[0].count) >= 0);
  }
});

after(() => pool.end());
```

- [ ] **Step 6: Run the test**

Run: `cd pipeline && npm test`
Expected: PASS (tables created, counts return 0+).

- [ ] **Step 7: Commit**

```bash
git add pipeline/src/db.js pipeline/src/schema.sql pipeline/src/migrate.js pipeline/test/db.test.js pipeline/package.json
git commit -m "feat(db): CockroachDB schema + connection + migration"
```

---

### Task 2: Normalization helpers

**Files:**
- Create: `pipeline/src/normalize.js`
- Test: `pipeline/test/normalize.test.js`

**Interfaces:**
- Produces: `normalizeApn(s) -> string`, `normalizeOwnerName(s) -> string`, `normalizeAddress(s) -> string`. Used by the Assessor adapter and (next cycle) the resolver.

- [ ] **Step 1: Write the failing test**

```js
// pipeline/test/normalize.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeApn, normalizeOwnerName, normalizeAddress } from '../src/normalize.js';

test('normalizeApn strips dashes/spaces and uppercases', () => {
  assert.equal(normalizeApn('123-45-678 A'), '12345678A');
  assert.equal(normalizeApn('  301-22-115  '), '30122115');
});

test('normalizeOwnerName uppercases, collapses spaces, strips punctuation/suffixes', () => {
  assert.equal(normalizeOwnerName('Smith, John A.'), 'SMITH JOHN A');
  assert.equal(normalizeOwnerName('ACME Holdings, LLC'), 'ACME HOLDINGS');
  assert.equal(normalizeOwnerName('Doe Family Trust'), 'DOE FAMILY');
});

test('normalizeAddress uppercases, expands nothing but collapses whitespace/punct', () => {
  assert.equal(normalizeAddress('123 N. Main St.'), '123 N MAIN ST');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && node --test test/normalize.test.js`
Expected: FAIL ("Cannot find module ../src/normalize.js").

- [ ] **Step 3: Implement `normalize.js`**

```js
// pipeline/src/normalize.js
export function normalizeApn(s) {
  return String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

const OWNER_NOISE = /\b(LLC|L L C|INC|CORP|CO|TRUST|TR|REVOCABLE|FAMILY|LP|LLP|LTD|ESTATE|ET AL)\b/g;

export function normalizeOwnerName(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(OWNER_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAddress(s) {
  return String(s ?? '')
    .toUpperCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && node --test test/normalize.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/src/normalize.js pipeline/test/normalize.test.js
git commit -m "feat(normalize): APN/owner/address normalization helpers"
```

---

### Task 3: Upsert layer + scrape_runs + adapter runner

**Files:**
- Create: `pipeline/src/upsert.js`
- Create: `pipeline/src/run.js`
- Test: `pipeline/test/upsert.test.js`

**Interfaces:**
- Consumes: `query`, `withTx` from `db.js`.
- Produces:
  - `upsertProperties(rows)` — rows shaped like the `properties` columns; ON CONFLICT(apn) DO UPDATE. Returns `{count}`.
  - `upsertSignals(records, {signalType, source})` — `records` are `NormalizedRecord`; ON CONFLICT(source, external_id) updates status/raw/event_date. Returns `{found, inserted}`.
  - `recordRun(run)` — inserts a `scrape_runs` row. `run = {source, startedAt, finishedAt, rowsFound, rowsNew, status, error, sourceMaxDate}`.
  - `run.js` exports `runAdapters(adapters)` and runs them all when invoked as a script.
- **NormalizedRecord** shape (every adapter emits this): `{ apn?, externalId, sourceUrl, eventDate?, status?, ownerName?, situsAddress?, raw }`.

- [ ] **Step 1: Write the failing test**

```js
// pipeline/test/upsert.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../src/migrate.js';
import { query, pool } from '../src/db.js';
import { upsertSignals, recordRun } from '../src/upsert.js';

before(() => migrate());

test('upsertSignals is idempotent on (source, external_id)', async () => {
  const src = 'test_src_' + Date.now();
  const recs = [{ externalId: 'A1', sourceUrl: 'http://x', eventDate: '2026-06-01', status: 'open', raw: { n: 1 } }];
  const first = await upsertSignals(recs, { signalType: 'code_violation', source: src });
  const second = await upsertSignals(recs, { signalType: 'code_violation', source: src });
  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  const r = await query('SELECT count(*) FROM signals WHERE source=$1', [src]);
  assert.equal(Number(r.rows[0].count), 1);
});

test('upsertSignals updates status on re-observe', async () => {
  const src = 'test_src2_' + Date.now();
  await upsertSignals([{ externalId: 'B1', raw: {}, status: 'open' }], { signalType: 'trustee_sale', source: src });
  await upsertSignals([{ externalId: 'B1', raw: {}, status: 'cancelled' }], { signalType: 'trustee_sale', source: src });
  const r = await query('SELECT status FROM signals WHERE source=$1 AND external_id=$2', [src, 'B1']);
  assert.equal(r.rows[0].status, 'cancelled');
});

test('recordRun inserts a run row', async () => {
  const src = 'test_run_' + Date.now();
  await recordRun({ source: src, startedAt: new Date(), finishedAt: new Date(), rowsFound: 5, rowsNew: 2, status: 'ok' });
  const r = await query('SELECT rows_found FROM scrape_runs WHERE source=$1', [src]);
  assert.equal(Number(r.rows[0].rows_found), 5);
});

after(() => pool.end());
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && node --test test/upsert.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `upsert.js`**

```js
// pipeline/src/upsert.js
import { query } from './db.js';

export async function upsertProperties(rows) {
  let count = 0;
  for (const r of rows) {
    await query(
      `INSERT INTO properties
        (apn, situs_address, situs_city, situs_zip, owner_name, owner_name_norm,
         mailing_address, absentee, year_built, living_sqft, building_type,
         last_sale_date, last_sale_price, assessed_value, legal_class, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT (apn) DO UPDATE SET
         situs_address=excluded.situs_address, situs_city=excluded.situs_city,
         situs_zip=excluded.situs_zip, owner_name=excluded.owner_name,
         owner_name_norm=excluded.owner_name_norm, mailing_address=excluded.mailing_address,
         absentee=excluded.absentee, year_built=excluded.year_built,
         living_sqft=excluded.living_sqft, building_type=excluded.building_type,
         last_sale_date=excluded.last_sale_date, last_sale_price=excluded.last_sale_price,
         assessed_value=excluded.assessed_value, legal_class=excluded.legal_class,
         updated_at=now()`,
      [r.apn, r.situsAddress, r.situsCity, r.situsZip, r.ownerName, r.ownerNameNorm,
       r.mailingAddress, r.absentee, r.yearBuilt, r.livingSqft, r.buildingType,
       r.lastSaleDate, r.lastSalePrice, r.assessedValue, r.legalClass]
    );
    count++;
  }
  return { count };
}

export async function upsertSignals(records, { signalType, source }) {
  let inserted = 0;
  for (const rec of records) {
    const res = await query(
      `INSERT INTO signals
        (apn, signal_type, source, source_url, external_id, event_date, status,
         owner_name, situs_address, raw, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (source, external_id) DO UPDATE SET
         status=excluded.status, event_date=excluded.event_date,
         raw=excluded.raw, owner_name=excluded.owner_name,
         situs_address=excluded.situs_address, updated_at=now()
       RETURNING (xmax = 0) AS is_insert`,
      [rec.apn ?? null, signalType, source, rec.sourceUrl ?? null, rec.externalId,
       rec.eventDate ?? null, rec.status ?? null, rec.ownerName ?? null,
       rec.situsAddress ?? null, rec.raw ?? {}]
    );
    if (res.rows[0]?.is_insert) inserted++;
  }
  return { found: records.length, inserted };
}

export async function recordRun(run) {
  await query(
    `INSERT INTO scrape_runs
      (source, started_at, finished_at, rows_found, rows_new, status, error, source_max_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [run.source, run.startedAt ?? null, run.finishedAt ?? null, run.rowsFound ?? null,
     run.rowsNew ?? null, run.status ?? null, run.error ?? null, run.sourceMaxDate ?? null]
  );
}
```

> Note: CockroachDB supports the `xmax = 0` insert-vs-update trick used by Postgres. If it returns unexpected values on Cockroach, fall back to checking existence first; the test in Step 1 will catch it.

- [ ] **Step 4: Run upsert test**

Run: `cd pipeline && node --test test/upsert.test.js`
Expected: PASS. If `is_insert` is wrong on Cockroach, switch to a pre-SELECT existence check inside `upsertSignals` and re-run.

- [ ] **Step 5: Implement `run.js`**

```js
// pipeline/src/run.js
import { upsertSignals, recordRun } from './upsert.js';
import { pool } from './db.js';

export async function runAdapters(adapters) {
  const summary = [];
  for (const adapter of adapters) {
    const startedAt = new Date();
    try {
      const records = await adapter.fetch({});
      const { found, inserted } = await upsertSignals(records, {
        signalType: adapter.signalType, source: adapter.id,
      });
      const sourceMaxDate = records.reduce((m, r) => (r.eventDate && r.eventDate > m ? r.eventDate : m), null);
      await recordRun({ source: adapter.id, startedAt, finishedAt: new Date(),
        rowsFound: found, rowsNew: inserted, status: 'ok', sourceMaxDate });
      summary.push({ source: adapter.id, found, inserted, status: 'ok' });
      console.log(`[${adapter.id}] ${found} found, ${inserted} new`);
    } catch (e) {
      await recordRun({ source: adapter.id, startedAt, finishedAt: new Date(), status: 'error', error: String(e).slice(0, 500) });
      summary.push({ source: adapter.id, status: 'error', error: String(e) });
      console.error(`[${adapter.id}] ERROR: ${e}`);
    }
  }
  return summary;
}

// Registry filled in as adapters land. Assessor runs separately (it writes properties, not signals).
const SIGNAL_ADAPTERS = [];

if (import.meta.url === `file://${process.argv[1]}`) {
  runAdapters(SIGNAL_ADAPTERS).then(() => pool.end());
}
```

- [ ] **Step 6: Commit**

```bash
git add pipeline/src/upsert.js pipeline/src/run.js pipeline/test/upsert.test.js
git commit -m "feat(pipeline): upsert layer, scrape_runs, adapter runner"
```

---

### Task 4: Assessor ingest (the spine)

**Files:**
- Create: `pipeline/scripts/probe.js`
- Create: `pipeline/src/sources/assessor.js`
- Create: `pipeline/test/fixtures/assessor_sample.csv` (from probe)
- Test: `pipeline/test/assessor.test.js`

**Interfaces:**
- Consumes: `normalizeApn`, `normalizeOwnerName` from `normalize.js`; `upsertProperties` from `upsert.js`.
- Produces: `parseAssessorRows(csvText) -> PropertyRow[]` (pure, testable) and `ingestAssessor()` (downloads, parses, upserts). `PropertyRow` matches `upsertProperties` input keys.

- [ ] **Step 1: Discover the real bulk files** — visit `https://mcassessor.maricopa.gov/page/data_sales/`, identify the current download URLs for the **Secured Master** (owner/address/valuation), **Residential Master** (year built/sqft), and **Sales** datasets. Record the exact URLs and the CSV header rows in a comment block at the top of `assessor.js`. (Schemas aren't published; you must read the headers.)

- [ ] **Step 2: Write `probe.js`** (reusable for every source — fetches a small live sample to a fixture)

```js
// pipeline/scripts/probe.js
// Usage: node scripts/probe.js <url> <outfile> [bytes]
import fs from 'node:fs';
const [, , url, out, bytes] = process.argv;
const res = await fetch(url);
const buf = Buffer.from(await res.arrayBuffer());
const slice = bytes ? buf.subarray(0, Number(bytes)) : buf;
fs.writeFileSync(out, slice);
console.log(`wrote ${slice.length} bytes from ${url} -> ${out}`);
```

- [ ] **Step 3: Create the fixture** — download the Secured Master ZIP, unzip, and save the header + first ~50 data rows to the fixture:

```bash
cd pipeline
# (URL discovered in Step 1; example shape only)
node scripts/probe.js "<SECURED_MASTER_CSV_URL>" data/secured_master.csv
head -51 data/secured_master.csv > test/fixtures/assessor_sample.csv
```

- [ ] **Step 4: Write the parser test against the fixture** (fill expected values from the real fixture rows you just saved)

```js
// pipeline/test/assessor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseAssessorRows } from '../src/sources/assessor.js';

const csv = fs.readFileSync(new URL('./fixtures/assessor_sample.csv', import.meta.url), 'utf8');

test('parseAssessorRows returns normalized property rows', () => {
  const rows = parseAssessorRows(csv);
  assert.ok(rows.length > 0);
  const r = rows[0];
  assert.match(r.apn, /^[0-9A-Z]+$/);          // normalized, no dashes
  assert.ok('ownerName' in r && 'situsAddress' in r && 'mailingAddress' in r);
  assert.equal(typeof r.absentee, 'boolean');   // mailing != situs
  assert.equal(r.ownerNameNorm, r.ownerNameNorm.toUpperCase());
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd pipeline && node --test test/assessor.test.js`
Expected: FAIL (parser not implemented).

- [ ] **Step 6: Implement `assessor.js`** — map the REAL column names from Step 1 into `PropertyRow`. Use a tiny CSV split (no dependency) or add `csv-parse` if quoting is gnarly. Sketch:

```js
// pipeline/src/sources/assessor.js
// SOURCE: https://mcassessor.maricopa.gov/page/data_sales/
// Secured Master columns (from real header, Step 1): <PASTE EXACT HEADER>
import { normalizeApn, normalizeOwnerName } from '../normalize.js';
import { upsertProperties } from '../upsert.js';

// minimal CSV line splitter handling quoted commas
function splitCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseAssessorRows(csvText) {
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  const header = splitCsv(lines[0]);
  const col = (name) => header.indexOf(name);
  // Map exact header names discovered in Step 1:
  const iApn = col('APN'), iOwner = col('OWNER_NAME'), iSitus = col('SITUS_ADDRESS'),
        iMail = col('MAIL_ADDRESS'), iVal = col('FCV');
  return lines.slice(1).map(splitCsv).map((c) => {
    const situs = (c[iSitus] || '').trim();
    const mailing = (c[iMail] || '').trim();
    const ownerName = (c[iOwner] || '').trim();
    return {
      apn: normalizeApn(c[iApn]),
      situsAddress: situs,
      mailingAddress: mailing,
      ownerName,
      ownerNameNorm: normalizeOwnerName(ownerName),
      absentee: !!mailing && !!situs && mailing.toUpperCase() !== situs.toUpperCase(),
      assessedValue: Number(String(c[iVal] || '').replace(/[^0-9.]/g, '')) || null,
      situsCity: null, situsZip: null, yearBuilt: null, livingSqft: null,
      buildingType: null, lastSaleDate: null, lastSalePrice: null, legalClass: null,
    };
  }).filter((r) => r.apn);
}

export async function ingestAssessor(csvText) {
  const rows = parseAssessorRows(csvText);
  // Upsert in batches to bound memory on the full ~1.7M-row file.
  const BATCH = 2000;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { count } = await upsertProperties(rows.slice(i, i + BATCH));
    total += count;
  }
  return { count: total };
}
```

> Year-built/sqft (Residential Master) and sale date/price (Sales) join on APN. For this task, ingest Secured Master only (owner/address/value spine). Add a follow-up step to enrich `year_built`, `living_sqft`, `last_sale_date`, `last_sale_price` from the other two files once the spine is proven — keep it a separate commit to stay bite-sized.

- [ ] **Step 7: Run test to verify it passes**

Run: `cd pipeline && node --test test/assessor.test.js`
Expected: PASS.

- [ ] **Step 8: Smoke-run the real ingest on a capped sample** (don't load 1.7M rows blind first)

```bash
cd pipeline
node -e "import('./src/sources/assessor.js').then(async m => {
  const fs = await import('node:fs');
  const csv = fs.readFileSync('test/fixtures/assessor_sample.csv','utf8');
  console.log(await m.ingestAssessor(csv));
  const { query, pool } = await import('./src/db.js');
  console.log((await query('SELECT count(*), count(*) FILTER (WHERE absentee) AS absentee FROM properties')).rows);
  await pool.end();
})"
```
Expected: ~50 properties inserted, some flagged absentee.

- [ ] **Step 9: Commit**

```bash
git add pipeline/scripts/probe.js pipeline/src/sources/assessor.js pipeline/test/assessor.test.js pipeline/test/fixtures/assessor_sample.csv
git commit -m "feat(assessor): parse + ingest Secured Master into properties spine"
```

- [ ] **Step 10: Full ingest** (after the smoke test passes) — run `ingestAssessor` on the full downloaded CSV. Verify total parcel count is in the ~1.6–1.8M range and absentee share is plausible (~20–30%). Record the count in `scrape_runs` manually or via a one-off `recordRun`.

---

### Task 5: Treasurer delinquent adapter (ArcGIS)

**Files:**
- Create: `pipeline/src/arcgis.js`
- Create: `pipeline/src/sources/treasurer.js`
- Create: `pipeline/test/fixtures/treasurer_sample.json` (from probe)
- Test: `pipeline/test/treasurer.test.js`

**Interfaces:**
- Produces: `fetchArcgisAll(serviceUrl, {where, outFields, pageSize}) -> Promise<Feature[]>` in `arcgis.js`; adapter `{ id:'treasurer_delinquent', signalType:'tax_delinquent', kind:'api', fetch }` and pure `mapTreasurer(features) -> NormalizedRecord[]`.

- [ ] **Step 1: Probe the FeatureServer** — confirm the layer + field names:

```bash
cd pipeline
node scripts/probe.js "https://services.arcgis.com/ykpntM6e3tHvzKRJ/arcgis/rest/services/ParcelLienDelinquent/FeatureServer/2/query?where=1%3D1&outFields=*&resultRecordCount=25&f=json" test/fixtures/treasurer_sample.json
```
Open the fixture; note the exact attribute keys for APN and situs address (e.g. `APN`, `PHYSICAL_ADDRESS`).

- [ ] **Step 2: Write `arcgis.js`** (generic paged fetch)

```js
// pipeline/src/arcgis.js
export async function fetchArcgisAll(serviceUrl, { where = '1=1', outFields = '*', pageSize = 2000 } = {}) {
  const features = [];
  let offset = 0;
  for (;;) {
    const u = `${serviceUrl}/query?where=${encodeURIComponent(where)}&outFields=${encodeURIComponent(outFields)}`
            + `&resultOffset=${offset}&resultRecordCount=${pageSize}&f=json`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(`ArcGIS ${res.status} ${serviceUrl}`);
    const json = await res.json();
    const batch = json.features ?? [];
    features.push(...batch);
    if (batch.length < pageSize || json.exceededTransferLimit === false) break;
    offset += pageSize;
    if (batch.length === 0) break;
    await new Promise(r => setTimeout(r, 200)); // polite
  }
  return features;
}
```

- [ ] **Step 3: Write the parser test against the fixture** (use exact keys observed in Step 1)

```js
// pipeline/test/treasurer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mapTreasurer } from '../src/sources/treasurer.js';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/treasurer_sample.json', import.meta.url)));

test('mapTreasurer maps features to normalized tax_delinquent records', () => {
  const recs = mapTreasurer(fx.features);
  assert.ok(recs.length > 0);
  const r = recs[0];
  assert.match(r.apn, /^[0-9A-Z]+$/);
  assert.equal(typeof r.externalId, 'string');
  assert.ok(r.raw);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd pipeline && node --test test/treasurer.test.js`
Expected: FAIL.

- [ ] **Step 5: Implement `treasurer.js`**

```js
// pipeline/src/sources/treasurer.js
import { normalizeApn } from '../normalize.js';
import { fetchArcgisAll } from '../arcgis.js';

const SERVICE = 'https://services.arcgis.com/ykpntM6e3tHvzKRJ/arcgis/rest/services/ParcelLienDelinquent/FeatureServer/2';

export function mapTreasurer(features) {
  return features.map((f) => {
    const a = f.attributes;
    const apn = normalizeApn(a.APN ?? a.PARCEL ?? a.Parcel);   // confirm key from fixture
    return {
      apn,
      externalId: apn,                                          // one delinquency per parcel
      sourceUrl: 'https://treasurer.maricopa.gov/',
      situsAddress: a.PHYSICAL_ADDRESS ?? a.SITUS ?? null,      // confirm key
      status: 'open',
      raw: a,
    };
  }).filter((r) => r.apn);
}

export default {
  id: 'treasurer_delinquent',
  signalType: 'tax_delinquent',
  kind: 'api',
  async fetch() {
    const features = await fetchArcgisAll(SERVICE);
    return mapTreasurer(features);
  },
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd pipeline && node --test test/treasurer.test.js`
Expected: PASS.

- [ ] **Step 7: Register + live-run** — add the adapter to `SIGNAL_ADAPTERS` in `run.js`, then:

```bash
cd pipeline && node src/run.js
```
Expected: `[treasurer_delinquent] ~167000 found, N new`. Re-run → `0 new` (idempotent).

- [ ] **Step 8: Commit**

```bash
git add pipeline/src/arcgis.js pipeline/src/sources/treasurer.js pipeline/test/treasurer.test.js pipeline/test/fixtures/treasurer_sample.json pipeline/src/run.js
git commit -m "feat(treasurer): tax-delinquent ArcGIS adapter + generic ArcGIS helper"
```

---

### Task 6: Code-violation adapters (Mesa, Glendale, Tempe, County, Scottsdale)

**Files:**
- Create: `pipeline/src/sources/code_mesa.js` (Socrata)
- Create: `pipeline/src/sources/code_glendale.js`, `code_tempe.js`, `code_county.js` (ArcGIS)
- Create: `pipeline/src/sources/code_scottsdale.js` (ArcGIS Hub)
- Create: fixtures `code_mesa_sample.json`, `code_glendale_sample.json`, etc.
- Test: `pipeline/test/code_sources.test.js`

**Interfaces:**
- Each module: `{ id, signalType:'code_violation', kind:'api', fetch }` + a pure `mapX(records) -> NormalizedRecord[]`. ArcGIS ones reuse `fetchArcgisAll`.

- [ ] **Step 1: Probe each source** (save fixtures):

```bash
cd pipeline
# Mesa (Socrata) — limit 25
node scripts/probe.js "https://data.mesaaz.gov/resource/hgf6-yenu.json?\$limit=25" test/fixtures/code_mesa_sample.json
# Glendale (ArcGIS)
node scripts/probe.js "https://services1.arcgis.com/9fVTQQSiODPjLUTa/arcgis/rest/services/GlendaleOne_Code_Compliance_Cases/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=25&f=json" test/fixtures/code_glendale_sample.json
# Tempe (ArcGIS)
node scripts/probe.js "https://services.arcgis.com/lQySeXwbBg53XWDi/arcgis/rest/services/code_complaints/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=25&f=json" test/fixtures/code_tempe_sample.json
# County unincorporated (ArcGIS) — discover the FeatureServer URL for Code_Case_Violations and probe similarly
```
Note the exact field keys per source (address, case id, violation type, status, dates; parcel where present).

- [ ] **Step 2: Write tests against fixtures** (one test per source; assert mapper returns records with `externalId`, `eventDate`, `situsAddress`/`apn`, `raw`)

```js
// pipeline/test/code_sources.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mapMesa } from '../src/sources/code_mesa.js';
import { mapGlendale } from '../src/sources/code_glendale.js';

const load = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));

test('mapMesa maps Socrata rows', () => {
  const recs = mapMesa(load('code_mesa_sample.json'));
  assert.ok(recs.length > 0);
  assert.ok(recs[0].externalId && recs[0].raw);
});

test('mapGlendale maps ArcGIS features', () => {
  const recs = mapGlendale(load('code_glendale_sample.json').features);
  assert.ok(recs.length > 0);
  assert.ok(recs[0].externalId && recs[0].raw);
});
// + analogous tests for tempe, county, scottsdale
```

- [ ] **Step 3: Run to verify failure**

Run: `cd pipeline && node --test test/code_sources.test.js`
Expected: FAIL.

- [ ] **Step 4: Implement `code_mesa.js`** (Socrata; paginate `$limit`/`$offset`)

```js
// pipeline/src/sources/code_mesa.js
import { normalizeApn } from '../normalize.js';
const BASE = 'https://data.mesaaz.gov/resource/hgf6-yenu.json';

export function mapMesa(rows) {
  return rows.map((r) => ({
    apn: r.parcel_number ? normalizeApn(r.parcel_number) : null,  // confirm key
    externalId: String(r.case_number ?? r.id),                    // confirm key
    sourceUrl: 'https://data.mesaaz.gov/',
    eventDate: r.open_date ? r.open_date.slice(0, 10) : null,      // confirm key
    status: r.case_status ?? null,                                 // confirm key
    situsAddress: r.address ?? null,                               // confirm key
    raw: r,
  })).filter((r) => r.externalId);
}

export default {
  id: 'code_mesa', signalType: 'code_violation', kind: 'api',
  async fetch() {
    const out = []; let offset = 0; const LIMIT = 1000;
    for (;;) {
      const res = await fetch(`${BASE}?$limit=${LIMIT}&$offset=${offset}&$order=:id`);
      if (!res.ok) throw new Error(`Mesa ${res.status}`);
      const rows = await res.json();
      out.push(...rows);
      if (rows.length < LIMIT) break;
      offset += LIMIT;
      await new Promise(r => setTimeout(r, 200));
    }
    return mapMesa(out);
  },
};
```

- [ ] **Step 5: Implement the ArcGIS code sources** (`code_glendale.js`, `code_tempe.js`, `code_county.js`, `code_scottsdale.js`) — each a thin mapper + `fetchArcgisAll`. Pattern (Glendale shown):

```js
// pipeline/src/sources/code_glendale.js
import { normalizeApn } from '../normalize.js';
import { fetchArcgisAll } from '../arcgis.js';
const SERVICE = 'https://services1.arcgis.com/9fVTQQSiODPjLUTa/arcgis/rest/services/GlendaleOne_Code_Compliance_Cases/FeatureServer/0';

export function mapGlendale(features) {
  return features.map((f) => {
    const a = f.attributes;
    return {
      apn: a.PARCEL ? normalizeApn(a.PARCEL) : null,        // confirm key
      externalId: String(a.CASE_NUMBER ?? a.OBJECTID),       // confirm key
      sourceUrl: 'https://www.glendaleaz.com/',
      eventDate: a.OPEN_DATE ? new Date(a.OPEN_DATE).toISOString().slice(0,10) : null, // ArcGIS epoch ms
      status: a.STATUS ?? null,
      situsAddress: a.ADDRESS ?? null,
      raw: a,
    };
  }).filter((r) => r.externalId);
}

export default {
  id: 'code_glendale', signalType: 'code_violation', kind: 'api',
  async fetch() { return mapGlendale(await fetchArcgisAll(SERVICE)); },
};
```

> County unincorporated (`code_county.js`): same pattern; this layer has APN directly. Data is ~8 months stale — set `status` and include the layer's last-edit date in `raw`, and note staleness in the commit. Scottsdale: ArcGIS Hub, 1-year rolling closed cases only — that's expected, not a bug.

- [ ] **Step 6: Run tests to verify pass**

Run: `cd pipeline && node --test test/code_sources.test.js`
Expected: PASS.

- [ ] **Step 7: Register all five in `run.js` + live-run**

```bash
cd pipeline && node src/run.js
```
Expected: each `code_*` source reports found/new counts. Re-run → 0 new.

- [ ] **Step 8: Commit**

```bash
git add pipeline/src/sources/code_*.js pipeline/test/code_sources.test.js pipeline/test/fixtures/code_*_sample.json pipeline/src/run.js
git commit -m "feat(code): Mesa/Glendale/Tempe/County/Scottsdale code-violation adapters"
```

---

### Task 7: Recorder NOTS scraper (Playwright)

**Files:**
- Modify: `pipeline/package.json` (add `playwright`)
- Create: `pipeline/src/sources/recorder_nots.js`
- Create: `pipeline/test/fixtures/recorder_results.html` (saved real results page)
- Test: `pipeline/test/recorder.test.js`

**Interfaces:**
- Produces: pure `parseRecorderRows(html) -> NormalizedRecord[]` (parses the results table) + adapter `{ id:'recorder_nots', signalType:'trustee_sale', kind:'scraper', fetch }`.

- [ ] **Step 1: Add Playwright**

```bash
cd pipeline && npm install playwright && npx playwright install chromium
```

- [ ] **Step 2: Manually capture a results-page fixture** — drive the legacy search once to save real HTML for the parser test:

```bash
cd pipeline
node -e "import('playwright').then(async ({chromium}) => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto('https://legacy.recorder.maricopa.gov/recdocdata/');
  // Fill doc-type = NS and a recent ~7-day date range using the real form fields, submit, wait for results table.
  // (Inspect the form in Step 3 to get selectors; this step just saves HTML once.)
  await p.waitForTimeout(1500);
  const fs = await import('node:fs');
  fs.writeFileSync('test/fixtures/recorder_results.html', await p.content());
  await b.close();
})"
```

- [ ] **Step 3: Inspect the form + results table** — open `https://legacy.recorder.maricopa.gov/recdocdata/` in `npx playwright codegen` to capture: the doc-type input (set to `NS`), date-range inputs, submit control, the results `<table>` selector, the per-row cell order (grantor, grantee, doc type, recording date, doc number), and the postback "next page" control. Record selectors as comments in `recorder_nots.js`.

- [ ] **Step 4: Write the parser test against the fixture** — assert `parseRecorderRows` extracts grantor/grantee/docNumber/recordingDate and excludes `CQ` cancellations:

```js
// pipeline/test/recorder.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseRecorderRows } from '../src/sources/recorder_nots.js';

const html = fs.readFileSync(new URL('./fixtures/recorder_results.html', import.meta.url), 'utf8');

test('parseRecorderRows extracts NOTS rows with doc number + grantor', () => {
  const rows = parseRecorderRows(html);
  assert.ok(rows.length > 0);
  const r = rows[0];
  assert.match(r.externalId, /^\d{4}\d+$/);     // document number YYYYNNNNNNN
  assert.ok(r.ownerName);                         // grantor = distressed owner
  assert.ok(r.eventDate);                         // recording date
});

test('parseRecorderRows excludes CQ cancellations', () => {
  const rows = parseRecorderRows(html);
  assert.ok(rows.every((r) => r.raw.docType !== 'CQ'));
});
```

- [ ] **Step 5: Run to verify failure**

Run: `cd pipeline && node --test test/recorder.test.js`
Expected: FAIL.

- [ ] **Step 6: Implement `recorder_nots.js`** — parser uses a real HTML parser (`node-html-parser`), NOT regex on innerText. Add the dep if needed (`npm install node-html-parser`). The `fetch()` drives Playwright: set doc type `NS`, date range = last N days, submit, loop postback pagination collecting `page.content()`, parse each, dedupe by doc number. Skeleton:

```js
// pipeline/src/sources/recorder_nots.js
// SELECTORS (from codegen, Step 3): docTypeInput=<...>, fromDate=<...>, toDate=<...>,
//   submitBtn=<...>, resultsTable=<...>, nextPage=<...>
import { parse } from 'node-html-parser';
import { chromium } from 'playwright';

export function parseRecorderRows(html) {
  const root = parse(html);
  const rows = root.querySelectorAll('table#<RESULTS_TABLE_ID> tr');  // exact id from Step 3
  const out = [];
  for (const tr of rows) {
    const cells = tr.querySelectorAll('td').map((c) => c.text.trim());
    if (cells.length < 5) continue;                       // skip header/empty
    const [grantor, grantee, docType, recDate, docNum] = cells; // confirm order in Step 3
    if (docType === 'CQ') continue;                        // exclude cancellations
    if (docType !== 'NS') continue;                        // only NOTS
    out.push({
      apn: null,                                           // not in index; resolved next cycle
      externalId: docNum.replace(/\D/g, ''),
      sourceUrl: 'https://legacy.recorder.maricopa.gov/recdocdata/',
      eventDate: toIso(recDate),
      status: 'open',
      ownerName: grantor,
      raw: { grantor, grantee, docType, recDate, docNum },
    });
  }
  return out;
}

function toIso(mdY) {
  const m = mdY.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}` : null;
}

export default {
  id: 'recorder_nots', signalType: 'trustee_sale', kind: 'scraper',
  async fetch({ days = 14 } = {}) {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto('https://legacy.recorder.maricopa.gov/recdocdata/');
      // set doc type NS + date range (selectors from Step 3), submit, wait for results
      const all = []; const seen = new Set();
      for (;;) {
        const recs = parseRecorderRows(await page.content());
        for (const r of recs) if (!seen.has(r.externalId)) { seen.add(r.externalId); all.push(r); }
        const next = await page.$('<NEXT_PAGE_SELECTOR>');
        if (!next) break;
        await next.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1000);                   // ≥1 rps polite
      }
      return all;
    } finally { await browser.close(); }
  },
};
```

- [ ] **Step 7: Run parser test to verify pass**

Run: `cd pipeline && node --test test/recorder.test.js`
Expected: PASS.

- [ ] **Step 8: Live smoke run** (small date window) + register in `run.js`

```bash
cd pipeline && node -e "import('./src/sources/recorder_nots.js').then(async m => { console.log((await m.default.fetch({days:7})).slice(0,3)); })"
```
Expected: a few real NOTS rows with grantor + doc number from the last week.

- [ ] **Step 9: Commit**

```bash
git add pipeline/src/sources/recorder_nots.js pipeline/test/recorder.test.js pipeline/test/fixtures/recorder_results.html pipeline/package.json pipeline/package-lock.json pipeline/src/run.js
git commit -m "feat(recorder): NOTS (trustee-sale) Playwright scraper"
```

---

### Task 8: Court probate scraper (Playwright/HTTP)

**Files:**
- Create: `pipeline/src/sources/court_probate.js`
- Create: `pipeline/test/fixtures/probate_case.html` (saved real case-detail page)
- Test: `pipeline/test/probate.test.js`

**Interfaces:**
- Produces: pure `parseProbateCase(html, caseNumber) -> NormalizedRecord | null` (returns null if no `Relationship = Decedent`) + adapter `{ id:'court_probate', signalType:'probate', kind:'scraper', fetch }` that walks `PB{year}-NNNNNN` case numbers.

- [ ] **Step 1: Capture a real decedent case fixture** — find a current `PB{year}-NNNNNN` with a Decedent party and save its detail HTML:

```bash
cd pipeline
node scripts/probe.js "https://www.superiorcourt.maricopa.gov/docket/ProbateCourtCases/caseInfo.asp?caseNumber=PB2025-008844" test/fixtures/probate_case.html
```
(If that number isn't a decedent estate, find one via the name/case search and re-save.)

- [ ] **Step 2: Write the parser test**

```js
// pipeline/test/probate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseProbateCase } from '../src/sources/court_probate.js';

const html = fs.readFileSync(new URL('./fixtures/probate_case.html', import.meta.url), 'utf8');

test('parseProbateCase returns a record for a decedent estate', () => {
  const rec = parseProbateCase(html, 'PB2025-008844');
  assert.ok(rec);
  assert.equal(rec.externalId, 'PB2025-008844');
  assert.ok(rec.ownerName);                 // decedent name
  assert.equal(rec.apn, null);              // resolved by name next cycle
});

test('parseProbateCase returns null when no decedent party', () => {
  assert.equal(parseProbateCase('<html><body>Guardianship only</body></html>', 'PB2025-000001'), null);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd pipeline && node --test test/probate.test.js`
Expected: FAIL.

- [ ] **Step 4: Implement `court_probate.js`** — parse the parties table with `node-html-parser`; only emit when a party row has `Relationship = Decedent`; capture decedent name + earliest docket date. The `fetch()` walks case numbers for the current year from a starting offset, throttled ≥1 rps (robots.txt courtesy), stopping after K consecutive misses.

```js
// pipeline/src/sources/court_probate.js
import { parse } from 'node-html-parser';

const BASE = 'https://www.superiorcourt.maricopa.gov/docket/ProbateCourtCases/caseInfo.asp?caseNumber=';

export function parseProbateCase(html, caseNumber) {
  const root = parse(html);
  const text = root.text;
  if (!/Decedent/i.test(text)) return null;
  // Find the party whose relationship is Decedent (confirm table structure in fixture).
  let decedent = null;
  for (const tr of root.querySelectorAll('tr')) {
    const cells = tr.querySelectorAll('td').map((c) => c.text.trim());
    if (cells.some((c) => /^Decedent$/i.test(c))) { decedent = cells.find((c) => /[A-Za-z]{2,}/.test(c)); break; }
  }
  if (!decedent) return null;
  const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
  const toIso = (m) => { const x = m?.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return x ? `${x[3]}-${x[1].padStart(2,'0')}-${x[2].padStart(2,'0')}` : null; };
  return {
    apn: null,
    externalId: caseNumber,
    sourceUrl: BASE + caseNumber,
    eventDate: toIso(dateMatch?.[1]),
    status: 'open',
    ownerName: decedent,
    raw: { caseNumber, decedent },
  };
}

export default {
  id: 'court_probate', signalType: 'probate', kind: 'scraper',
  async fetch({ year = new Date().getFullYear(), start = 1, max = 12000, missStop = 50 } = {}) {
    const out = []; let misses = 0;
    for (let n = start; n <= max; n++) {
      const caseNumber = `PB${year}-${String(n).padStart(6, '0')}`;
      const res = await fetch(BASE + caseNumber);
      await new Promise(r => setTimeout(r, 1100));        // ≥1 rps, robots courtesy
      if (!res.ok) { misses++; if (misses >= missStop) break; continue; }
      const rec = parseProbateCase(await res.text(), caseNumber);
      if (rec) { out.push(rec); misses = 0; } else { misses++; if (misses >= missStop) break; }
    }
    return out;
  },
};
```

> The walk is the only option (no date filter). For the daily routine, persist the highest case number seen in `scrape_runs.source_max_date`-style state and resume from there — note this as a routine concern (next cycle), not built here.

- [ ] **Step 5: Run parser test to verify pass**

Run: `cd pipeline && node --test test/probate.test.js`
Expected: PASS.

- [ ] **Step 6: Live smoke run** (tiny window — 20 cases) to confirm the walk + parse works end-to-end:

```bash
cd pipeline && node -e "import('./src/sources/court_probate.js').then(async m => { console.log(await m.default.fetch({start: 8800, max: 8820, missStop: 999})); })"
```
Expected: at least one decedent record from the sampled range.

- [ ] **Step 7: Register in `run.js` + commit**

```bash
git add pipeline/src/sources/court_probate.js pipeline/test/probate.test.js pipeline/test/fixtures/probate_case.html pipeline/src/run.js
git commit -m "feat(court): probate (decedent-estate) scraper"
```

---

### Task 9: Phoenix code scraper (Playwright, Accela)

**Files:**
- Create: `pipeline/src/sources/phoenix_code.js`
- Create: `pipeline/test/fixtures/phoenix_results.html`
- Test: `pipeline/test/phoenix.test.js`

**Interfaces:**
- Produces: pure `parsePhoenixRows(html) -> NormalizedRecord[]` + adapter `{ id:'phoenix_code', signalType:'code_violation', kind:'scraper', fetch }`.

- [ ] **Step 1: Inspect the Accela portal** — `npx playwright codegen "https://aca-prod.accela.com/COHP"`. Navigate to the code-enforcement record search, set a recent date range, run the search, and capture: search-form selectors, the results-grid selector, per-row cell order (record #, date, type, address, status), and pagination. Accela 403s non-browser agents, so this MUST run through Playwright.

- [ ] **Step 2: Save a results fixture** (drive the search once, save `page.content()` to `test/fixtures/phoenix_results.html`) — same approach as Task 7 Step 2.

- [ ] **Step 3: Write the parser test**

```js
// pipeline/test/phoenix.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePhoenixRows } from '../src/sources/phoenix_code.js';

const html = fs.readFileSync(new URL('./fixtures/phoenix_results.html', import.meta.url), 'utf8');

test('parsePhoenixRows extracts code cases with record id + address', () => {
  const rows = parsePhoenixRows(html);
  assert.ok(rows.length > 0);
  assert.ok(rows[0].externalId && rows[0].situsAddress);
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd pipeline && node --test test/phoenix.test.js`
Expected: FAIL.

- [ ] **Step 5: Implement `phoenix_code.js`** — `node-html-parser` over the Accela results grid (selectors from Step 1); `fetch()` drives Playwright (date range = last N days), paginating the grid, throttled ≥1 rps. APN not exposed → `apn: null`, resolve via address next cycle.

```js
// pipeline/src/sources/phoenix_code.js
// SELECTORS (codegen, Step 1): searchTab, fromDate, toDate, searchBtn, resultsGrid, rowSel, nextPage
import { parse } from 'node-html-parser';
import { chromium } from 'playwright';

export function parsePhoenixRows(html) {
  const root = parse(html);
  const out = [];
  for (const tr of root.querySelectorAll('<ROW_SELECTOR>')) {   // exact selector from Step 1
    const cells = tr.querySelectorAll('td').map((c) => c.text.trim());
    if (cells.length < 4) continue;
    const [recordId, date, type, address, status] = cells;       // confirm order
    if (!recordId) continue;
    out.push({
      apn: null,
      externalId: recordId,
      sourceUrl: 'https://aca-prod.accela.com/COHP',
      eventDate: (date.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/) || []).slice(1).length
        ? (() => { const m = date.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`; })()
        : null,
      status: status ?? null,
      situsAddress: address ?? null,
      raw: { recordId, date, type, address, status },
    });
  }
  return out;
}

export default {
  id: 'phoenix_code', signalType: 'code_violation', kind: 'scraper',
  async fetch({ days = 14 } = {}) {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto('https://aca-prod.accela.com/COHP');
      // navigate to code-enforcement search, set date range, submit (selectors from Step 1)
      const all = []; const seen = new Set();
      for (;;) {
        for (const r of parsePhoenixRows(await page.content())) {
          if (!seen.has(r.externalId)) { seen.add(r.externalId); all.push(r); }
        }
        const next = await page.$('<NEXT_PAGE_SELECTOR>');
        if (!next) break;
        await next.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1100);
      }
      return all;
    } finally { await browser.close(); }
  },
};
```

- [ ] **Step 6: Run parser test to verify pass**

Run: `cd pipeline && node --test test/phoenix.test.js`
Expected: PASS.

- [ ] **Step 7: Live smoke run + register in `run.js`**

```bash
cd pipeline && node -e "import('./src/sources/phoenix_code.js').then(async m => { console.log((await m.default.fetch({days:7})).slice(0,3)); })"
```
Expected: a few real Phoenix code cases from the last week.

- [ ] **Step 8: Final full run + commit**

```bash
cd pipeline && node src/run.js   # all signal adapters
git add pipeline/src/sources/phoenix_code.js pipeline/test/phoenix.test.js pipeline/test/fixtures/phoenix_results.html pipeline/src/run.js
git commit -m "feat(phoenix): Accela code-violation Playwright scraper"
```

- [ ] **Step 9: Phase 1–3 acceptance check** — run a summary query and confirm the database holds real distress data:

```bash
cd pipeline && node -e "import('./src/db.js').then(async ({query,pool}) => {
  console.log('properties:', (await query('SELECT count(*) FROM properties')).rows[0].count);
  console.log((await query(\"SELECT signal_type, source, count(*) FROM signals GROUP BY 1,2 ORDER BY 1,2\")).rows);
  console.log((await query('SELECT source, status, rows_found, rows_new FROM scrape_runs ORDER BY started_at DESC LIMIT 12')).rows);
  await pool.end();
})"
```
Expected: ~1.7M properties; signal counts across `tax_delinquent`, `code_violation` (5 cities), `trustee_sale`, `probate`; recent `scrape_runs` all `ok`.

---

## Self-Review

**Spec coverage:**
- Schema (properties/signals/scrape_runs) → Task 1. ✓
- Adapter interface + NormalizedRecord → Task 3 (defined), used by Tasks 5–9. ✓
- Assessor spine + absentee + resolution-layer owner_name_norm → Tasks 2, 4. ✓
- Treasurer delinquent → Task 5. ✓
- All five code sources (Mesa/Glendale/Tempe/County/Scottsdale) → Task 6. ✓
- Recorder NOTS (NS, exclude CQ) → Task 7. ✓
- Court probate (Decedent, PB walk, robots throttle) → Task 8. ✓
- Phoenix code (Accela Playwright) → Task 9. ✓
- Idempotency / never-delete / accruing history → Task 3 upsert design. ✓
- Skip-trace stays disabled → Global Constraints (out of scope). ✓
- Resolution + scoring + routine + dashboard → explicitly **next cycle**, not in this plan. ✓ (matches spec build sequence)

**Placeholder note:** the `<...>` markers in Tasks 4, 7, 8, 9 are **deliberate discovery outputs** — exact CSV headers, ArcGIS field keys, and DOM selectors that cannot be known without hitting the live source, and each is paired with a concrete probe/codegen step that produces the value before the code step runs. They are not lazy TODOs; they are the points where real-world data must be observed. Every test and command is concrete.

**Type consistency:** `NormalizedRecord` keys (`apn, externalId, sourceUrl, eventDate, status, ownerName, situsAddress, raw`) are used identically across `upsertSignals` (Task 3) and all adapters (Tasks 4–9). `PropertyRow` keys match `upsertProperties` (Tasks 3, 4). ✓
