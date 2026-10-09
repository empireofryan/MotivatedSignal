import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePhoenixDetail, findLiveFrontier, getMaxCaseN } from '../src/sources/phoenix_code.js';
import { migrate } from '../src/migrate.js';
import { query, pool } from '../src/db.js';
import { upsertSignals } from '../src/upsert.js';

const realHtml = fs.readFileSync(
  new URL('./fixtures/phoenix_detail.html', import.meta.url),
  'utf8',
);

const missingHtml = fs.readFileSync(
  new URL('./fixtures/phoenix_missing.html', import.meta.url),
  'utf8',
);

// Pinned values from fixture PEF2026-18550
const FIXTURE_CASE = 'PEF2026-18550';
const FIXTURE_ADDRESS = '2501 E MONTEROSA ST PHOENIX 85016-5665';
const FIXTURE_DATE = '2026-06-09';
const FIXTURE_OWNER = 'DOE JOHN Q';
const FIXTURE_STATUS = 'CLOSED COMPLIANCE';

// --- RED → GREEN: parsePhoenixDetail on a real detail page ---

test('parsePhoenixDetail returns non-null for a real case page', () => {
  const rec = parsePhoenixDetail(realHtml, FIXTURE_CASE);
  assert.notEqual(rec, null, 'should return a record for a real case');
});

test('parsePhoenixDetail sets externalId to the case number', () => {
  const rec = parsePhoenixDetail(realHtml, FIXTURE_CASE);
  assert.equal(rec.externalId, FIXTURE_CASE);
});

test('parsePhoenixDetail extracts pinned situsAddress', () => {
  const rec = parsePhoenixDetail(realHtml, FIXTURE_CASE);
  assert.ok(rec.situsAddress, 'situsAddress must be non-empty');
  assert.equal(rec.situsAddress, FIXTURE_ADDRESS);
});

test('parsePhoenixDetail extracts eventDate as ISO YYYY-MM-DD', () => {
  const rec = parsePhoenixDetail(realHtml, FIXTURE_CASE);
  assert.match(rec.eventDate, /^\d{4}-\d{2}-\d{2}$/, 'eventDate must be ISO format');
  assert.equal(rec.eventDate, FIXTURE_DATE);
});

test('parsePhoenixDetail extracts ownerName from Responsible Party', () => {
  const rec = parsePhoenixDetail(realHtml, FIXTURE_CASE);
  assert.equal(rec.ownerName, FIXTURE_OWNER);
});

test('parsePhoenixDetail extracts status', () => {
  const rec = parsePhoenixDetail(realHtml, FIXTURE_CASE);
  assert.equal(rec.status, FIXTURE_STATUS);
});

test('parsePhoenixDetail sets apn to null', () => {
  const rec = parsePhoenixDetail(realHtml, FIXTURE_CASE);
  assert.equal(rec.apn, null);
});

test('parsePhoenixDetail includes raw with caseNumber and caseOpened', () => {
  const rec = parsePhoenixDetail(realHtml, FIXTURE_CASE);
  assert.ok(rec.raw, 'must have raw field');
  assert.equal(rec.raw.caseNumber, FIXTURE_CASE);
  assert.ok(rec.raw.caseOpened, 'raw.caseOpened must be non-empty');
});

test('parsePhoenixDetail has sourceUrl containing the case number', () => {
  const rec = parsePhoenixDetail(realHtml, FIXTURE_CASE);
  assert.ok(rec.sourceUrl.includes(FIXTURE_CASE.replace(/[-]/g, (c) => c)), 'sourceUrl must reference the case');
  assert.ok(rec.sourceUrl.startsWith('https://'), 'sourceUrl must be https');
});

// --- Miss-detection: error page returns null ---

test('parsePhoenixDetail returns null for a missing/error page', () => {
  const rec = parsePhoenixDetail(missingHtml, 'PEF2026-99999');
  assert.equal(rec, null, 'error page must return null');
});

test('parsePhoenixDetail returns null for wrong case number on real page', () => {
  // Passing a different case number to a real page → heading won't match → null
  const rec = parsePhoenixDetail(realHtml, 'PEF2026-00001');
  assert.equal(rec, null, 'mismatched case number must return null');
});

// --- NormalizedRecord shape ---

test('parsePhoenixDetail returns full NormalizedRecord shape', () => {
  const rec = parsePhoenixDetail(realHtml, FIXTURE_CASE);
  assert.ok('apn' in rec, 'must have apn key');
  assert.ok('externalId' in rec, 'must have externalId key');
  assert.ok('sourceUrl' in rec, 'must have sourceUrl key');
  assert.ok('eventDate' in rec, 'must have eventDate key');
  assert.ok('status' in rec, 'must have status key');
  assert.ok('ownerName' in rec, 'must have ownerName key');
  assert.ok('situsAddress' in rec, 'must have situsAddress key');
  assert.ok('raw' in rec, 'must have raw key');
});

// --- findLiveFrontier: gallop + binary search over a fake case-number space ---

// Simulates a dead zone below `liveStart`, live cases [liveStart, liveEnd],
// and dead again above — mirrors the real site archiving old case numbers.
function makeRangeProbe(liveStart, liveEnd) {
  const calls = [];
  const probe = async (n) => {
    calls.push(n);
    return n >= liveStart && n <= liveEnd ? 'hit' : 'miss';
  };
  probe.calls = calls;
  return probe;
}

test('findLiveFrontier finds the exact boundary when seeded below a dead zone', async () => {
  const probe = makeRangeProbe(10000, 29836);
  const frontier = await findLiveFrontier({ seed: 1, max: 100000, probe });
  assert.equal(frontier, 10000);
});

test('findLiveFrontier returns the seed immediately when it is already live', async () => {
  const probe = makeRangeProbe(10000, 29836);
  const frontier = await findLiveFrontier({ seed: 19780, max: 100000, probe });
  assert.equal(frontier, 19780);
  assert.equal(probe.calls.length, 1, 'no gallop/binary-search needed when the seed itself is a hit');
});

test('findLiveFrontier finds the boundary when seeded inside the dead zone close to the frontier', async () => {
  const probe = makeRangeProbe(10000, 29836);
  const frontier = await findLiveFrontier({ seed: 9500, max: 100000, probe });
  assert.equal(frontier, 10000);
});

test('findLiveFrontier returns null when no live case exists before max', async () => {
  const probe = makeRangeProbe(10000, 29836);
  const frontier = await findLiveFrontier({ seed: 1, max: 5000, probe });
  assert.equal(frontier, null);
});

test('findLiveFrontier returns null when seed is already past max', async () => {
  const probe = makeRangeProbe(10000, 29836);
  const frontier = await findLiveFrontier({ seed: 100000, max: 100000, probe });
  assert.equal(frontier, null);
});

test('findLiveFrontier respects maxProbes and does not loop forever', async () => {
  const probe = makeRangeProbe(10000, 29836);
  await findLiveFrontier({ seed: 1, max: 1_000_000, probe, maxProbes: 10 });
  assert.ok(probe.calls.length <= 10, `expected <=10 probes, got ${probe.calls.length}`);
});

// --- getMaxCaseN: real DB, isolated via a fake source so it never touches
// production phoenix_code rows ---

before(() => migrate());

test('getMaxCaseN returns the highest numeric suffix for the given year, ignoring other years', async () => {
  const src = 'phxtest_maxn_' + Date.now();
  await upsertSignals(
    [
      { externalId: 'PEF2025-99999', raw: {} },
      { externalId: 'PEF2026-100', raw: {} },
      { externalId: 'PEF2026-19780', raw: {} },
      { externalId: 'PEF2026-500', raw: {} },
    ],
    { signalType: 'code_violation', source: src }
  );
  const max = await getMaxCaseN(2026, { source: src });
  assert.equal(max, 19780);
});

test('getMaxCaseN returns 0 when no rows exist for the source', async () => {
  const max = await getMaxCaseN(2026, { source: 'phxtest_none_' + Date.now() });
  assert.equal(max, 0);
});

after(async () => {
  // Scoped to this file's own prefix (not the shared 'test_' prefix used by
  // upsert.test.js/resolve.test.js) — node's test runner runs files
  // concurrently, and a shared broad wildcard caused cross-file deletes of
  // in-flight rows (observed as flaky "idempotent" assertion failures).
  await query("DELETE FROM signals WHERE source LIKE 'phxtest\\_%'");
  await pool.end();
});
