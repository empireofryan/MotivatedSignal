# Phase 4 — Resolution + Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the raw signal lake into a ranked motivated-seller list: resolve apn-less signals (NOTS/probate by owner name, Glendale/Tempe code by address) to parcels, then compute a per-parcel motivation score with signal stacking + assessor modifiers, and expose a ranked "today's leads" query.

**Architecture:** Two pure-SQL/JS passes run after ingest. (1) `resolve.js` matches unresolved signals to `properties` conservatively — auto-assign `apn` only on a UNIQUE match, mark multi-matches `ambiguous` (candidates kept in `raw.resolution`), never silently drop/guess; sets `match_confidence` + `resolved`. (2) `score.js` aggregates resolved signals + assessor attributes into a `scores` table (apn PK). A `leads.js` CLI prints the ranked list. All deterministic; no LLM, no network.

**Tech Stack:** Node 22 ESM, `pg` (CockroachDB), `node:test`. Reuses `src/normalize.js` (`normalizeOwnerName`, `normalizeAddress`), `src/db.js`.

## Global Constraints
- ESM. CockroachDB `motivated_sellers` via `DATABASE_URL`. No LLM SDKs/APIs, no Google APIs, only project DATABASE_URL.
- **Normalization must be identical** between matcher and the indexed column it matches against — both use the SAME JS helper (`normalizeOwnerName` / `normalizeAddress`). Never normalize one side in SQL and the other in JS (drift = silent misses).
- **Conservative matching:** unique match → set `apn`, `resolved=true`, confidence per source; multi-match → `apn` stays null, `resolved=true`, `match_confidence='ambiguous'`, candidate apns + count in `raw.resolution`; zero match → `resolved=true`, `match_confidence='none'`. Skip names/addresses shorter than 4 chars → `none`.
- `scores` is a DERIVED table — safe to rebuild, but rebuild via upsert/`INSERT…ON CONFLICT`, not bulk DELETE/TRUNCATE.
- Tests that write to the live DB must clean up their own rows in an `after()` hook (no `test_*` pollution).

---

### Task 1: Resolution pass

**Files:**
- Create: `pipeline/src/resolve.js`
- Modify: `pipeline/src/schema.sql` (add `situs_norm` column + index to `properties`)
- Create: `pipeline/src/migrate_situs_norm.js` (one-off: add column, populate via JS normalizeAddress, index)
- Test: `pipeline/test/resolve.test.js`

**Interfaces:**
- Consumes: `normalizeOwnerName`, `normalizeAddress`, `query`.
- Produces: `resolveSignals({limit})` — resolves all unresolved signals; returns `{attempted, assigned, ambiguous, none}`. Pure helper `classifyMatches(candidates)` → `{apn|null, confidence}` (1→apn+conf, >1→null+'ambiguous', 0→null+'none').

- [ ] **Step 1: Add `situs_norm` to schema.sql** (for fresh installs) — after the `properties` columns, add `situs_norm STRING` and `CREATE INDEX IF NOT EXISTS idx_properties_situs_norm ON properties (situs_norm);`

- [ ] **Step 2: Write `migrate_situs_norm.js`** — idempotent: `ALTER TABLE properties ADD COLUMN IF NOT EXISTS situs_norm STRING;` then populate in batches using JS `normalizeAddress(situs_address)` (stream apns in pages of 5000, `UPDATE properties SET situs_norm=$1 WHERE apn=$2` — or batch via a VALUES join), then create the index. Print rows updated. This is a ~1.76M-row one-off; batch it, expect minutes.

- [ ] **Step 3: Write the failing test** (`resolve.test.js`) for the pure classifier + a small live round-trip:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMatches } from '../src/resolve.js';
import { query, pool } from '../src/db.js';

test('classifyMatches: unique → assign', () => {
  const r = classifyMatches(['12345678'], 'probable');
  assert.equal(r.apn, '12345678'); assert.equal(r.confidence, 'probable');
});
test('classifyMatches: multiple → ambiguous, no apn', () => {
  const r = classifyMatches(['A','B','C'], 'probable');
  assert.equal(r.apn, null); assert.equal(r.confidence, 'ambiguous');
});
test('classifyMatches: none → none', () => {
  const r = classifyMatches([], 'probable');
  assert.equal(r.apn, null); assert.equal(r.confidence, 'none');
});

after(async () => { await query("DELETE FROM signals WHERE source LIKE 'test\\_%'"); await pool.end(); });
```

- [ ] **Step 4: Run test to verify it fails** — `cd pipeline && node --test test/resolve.test.js` → FAIL (module missing).

- [ ] **Step 5: Implement `resolve.js`.** `classifyMatches(apns, confidenceWhenUnique)`: `apns.length===1` → `{apn:apns[0], confidence:confidenceWhenUnique}`; `>1` → `{apn:null, confidence:'ambiguous'}`; `0` → `{apn:null, confidence:'none'}`.
  `resolveSignals()`:
  - First, mark already-resolved: `UPDATE signals SET resolved=true, match_confidence='source' WHERE apn IS NOT NULL AND resolved=false`.
  - **NOTS + probate (name match):** select unresolved signals where `owner_name` is not null and source in ('recorder_nots','court_probate'). For each, `norm = normalizeOwnerName(owner_name)`; skip if `norm.length < 4` → mark `none`. Query `SELECT apn FROM properties WHERE owner_name_norm = $1 LIMIT 50`. `classifyMatches(apns, 'probable')`. Update signal: set `apn` (if assigned), `match_confidence`, `resolved=true`, and merge `{resolution:{candidates:apns.slice(0,20), count:apns.length}}` into `raw`.
  - **Glendale/Tempe code (address match):** select unresolved signals where `apn IS NULL` and `situs_address` not null and source in ('code_glendale','code_tempe'). `norm = normalizeAddress(situs_address)`; skip <4 → none. Query `SELECT apn FROM properties WHERE situs_norm = $1 LIMIT 50`. `classifyMatches(apns, 'exact')` (address match is strong → 'exact' when unique). Update as above.
  - Batch the per-signal queries (they hit indexed columns; fine to loop, but commit updates in chunks). Return counts.
  - Make it a CLI entrypoint (`if import.meta.url===…`) that runs `resolveSignals()` then `pool.end()`.

- [ ] **Step 6: Run tests** → PASS. Then run `migrate_situs_norm.js` (one-off, may take minutes), then run `resolve.js` live. Report: assigned / ambiguous / none per source, and the new count of NOTS/probate/code signals with apn set.

- [ ] **Step 7: Commit** — `feat(resolve): conservative name/address resolution of apn-less signals`.

---

### Task 2: Scoring

**Files:**
- Create: `pipeline/src/score.js`
- Modify: `pipeline/src/schema.sql` (add `scores` table)
- Test: `pipeline/test/score.test.js`

**Interfaces:**
- Produces: `scoreFor(signalTypes, modifiers, freshness)` (pure, returns int) + `computeScores()` (rebuilds `scores`). `scores`: `apn STRING PK, score INT, hot BOOL, signal_types STRING[], components JSONB, updated_at TIMESTAMPTZ`.

- [ ] **Step 1: Add `scores` table to schema.sql:**
```sql
CREATE TABLE IF NOT EXISTS scores (
  apn          STRING PRIMARY KEY REFERENCES properties(apn),
  score        INT NOT NULL,
  hot          BOOL NOT NULL DEFAULT false,
  signal_types STRING[],
  components   JSONB,
  updated_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores (score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_hot ON scores (hot) WHERE hot = true;
```
(Run the DDL against the live DB too.)

- [ ] **Step 2: Write the failing test** (`score.test.js`) for the pure scorer with these weights:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreFor, WEIGHTS } from '../src/score.js';

test('single tax_delinquent uses its weight', () => {
  assert.equal(scoreFor(['tax_delinquent'], {}, {}), WEIGHTS.tax_delinquent);
});
test('stacking adds a bonus per extra distinct type', () => {
  const two = scoreFor(['tax_delinquent','code_violation'], {}, {});
  assert.equal(two, WEIGHTS.tax_delinquent + WEIGHTS.code_violation + WEIGHTS.stack_bonus);
});
test('absentee + fresh modifiers add', () => {
  const s = scoreFor(['trustee_sale'], { absentee:true }, { fresh:true });
  assert.equal(s, WEIGHTS.trustee_sale + WEIGHTS.absentee + WEIGHTS.fresh);
});
```

- [ ] **Step 3: Run → FAIL.**

- [ ] **Step 4: Implement `score.js`.** Weights (best-judgment v1, tunable): `{ trustee_sale:50, probate:35, code_violation:25, tax_delinquent:20, stack_bonus:15, absentee:10, high_equity:10, long_tenure:5, fresh:10 }`.
  `scoreFor(signalTypes, modifiers, freshness)`: sum weights of distinct present types + `stack_bonus*(distinctTypes-1)` when >1 + modifier weights (absentee/high_equity/long_tenure if true) + `fresh` if freshness.fresh. Return int.
  `computeScores()`: one aggregation over signal-bearing parcels —
  - For each `apn` with ≥1 resolved signal (`apn IS NOT NULL`), gather distinct `signal_type`s and the max `observed_date`/`event_date`.
  - Join `properties` for modifiers: `absentee`; `high_equity` = `assessed_value` present and `last_sale_date` older than ~10y (or null sale) ; `long_tenure` = `last_sale_date` older than ~15y.
  - `fresh` = any signal `event_date`/`observed_date` within last 30 days.
  - Compute score via the same weight logic (do it in JS: SELECT the per-apn aggregates, compute in a loop, upsert into `scores`). `hot = score >= 60 OR distinctTypes >= 2`.
  - Rebuild via `INSERT … ON CONFLICT (apn) DO UPDATE` in chunks. Store `components` (the per-factor breakdown) as JSONB for explainability.
  - CLI entrypoint runs `computeScores()` then `pool.end()`.

- [ ] **Step 5: Run tests → PASS.** Then run `score.js` live; report total scored parcels, count `hot=true`, and the score distribution (a few buckets).

- [ ] **Step 6: Commit** — `feat(score): per-parcel motivation score with stacking + assessor modifiers`.

---

### Task 3: Ranked leads query (the product primitive)

**Files:**
- Create: `pipeline/src/leads.js`
- Test: `pipeline/test/leads.test.js`

**Interfaces:**
- Produces: `topLeads({limit, city, minScore, hotOnly})` → array of `{apn, score, hot, signalTypes, ownerName, situsAddress, mailingAddress, absentee, components}` joined from `scores`+`properties`. CLI prints a readable ranked table.

- [ ] **Step 1: Write the failing test** — `topLeads({limit:5})` returns ≤5 rows sorted by score desc, each with the expected keys; `topLeads({hotOnly:true})` returns only `hot` rows. (Live read-only; `after()` closes pool.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `leads.js`** — parameterized SELECT joining `scores` to `properties` (and optionally aggregating the parcel's signal sources for display), `ORDER BY score DESC LIMIT`. Filters: `city` (situs_city ILIKE), `minScore`, `hotOnly`. CLI prints a table: rank, score, hot flag, address, owner, signal types. This is the stand-in for the daily list until the Phase 6 dashboard.

- [ ] **Step 4: Run tests → PASS.** Live-run the CLI; paste the top ~15 leads in the report (the real ranked motivated-seller list).

- [ ] **Step 5: Commit** — `feat(leads): ranked motivated-seller query + CLI`.

---

## Self-Review
- Resolution (name + address, conservative, confidence-tagged, candidates kept) → Task 1. ✓
- `situs_norm` indexed via the SAME JS normalizer as the matcher → Task 1 (no SQL/JS drift). ✓
- Scoring with stacking + assessor modifiers + freshness, explainable `components` → Task 2. ✓
- Ranked daily-list primitive → Task 3. ✓
- Conservative policy (unique-only auto-assign, ambiguous surfaced, never silent-drop) in Global Constraints + Task 1. ✓
- No test pollution (after() cleanup) ; derived `scores` rebuilt via upsert not TRUNCATE. ✓
- Type consistency: `classifyMatches`, `resolveSignals`, `scoreFor`/`WEIGHTS`/`computeScores`, `topLeads` names used consistently across tasks. ✓
