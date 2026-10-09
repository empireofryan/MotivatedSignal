import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../src/migrate.js';
import { query, pool } from '../src/db.js';
import {
  median,
  isVolumeDrop,
  getRecentMedian,
  evaluateVolume,
  renderSourceHealthTable,
  CRITICAL_SOURCES,
} from '../src/volume-check.js';

before(() => migrate());

// --- median() ---

test('median of an odd-length array is the middle value', () => {
  assert.equal(median([3, 1, 2]), 2);
});

test('median of an even-length array averages the two middle values', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('median of an empty array is null', () => {
  assert.equal(median([]), null);
});

// --- isVolumeDrop() ---

test('isVolumeDrop: no baseline (median null) never warns', () => {
  assert.equal(isVolumeDrop(0, null), false);
  assert.equal(isVolumeDrop(100, null), false);
});

test('isVolumeDrop: median of 0 never warns (source legitimately finds nothing most days)', () => {
  assert.equal(isVolumeDrop(0, 0), false);
});

test('isVolumeDrop: found 0 against a positive median warns', () => {
  assert.equal(isVolumeDrop(0, 12), true);
});

test('isVolumeDrop: found below 10% of a median >= 50 warns', () => {
  assert.equal(isVolumeDrop(4, 100), true); // 4% of 100
});

test('isVolumeDrop: found at or above 10% of a median >= 50 does not warn', () => {
  assert.equal(isVolumeDrop(10, 100), false); // exactly 10%
  assert.equal(isVolumeDrop(50, 100), false);
});

test('isVolumeDrop: a small median (<50) only triggers on an exact 0, not the 10% rule', () => {
  assert.equal(isVolumeDrop(1, 20), false); // 5% of 20, but median<50 so the ratio rule doesn't apply
  assert.equal(isVolumeDrop(0, 20), true);
});

// --- getRecentMedian() / evaluateVolume(): real DB, isolated via fake sources ---

async function insertRun(source, { rowsFound, status = 'ok', startedAt }) {
  await query(
    `INSERT INTO scrape_runs (source, started_at, finished_at, rows_found, rows_new, status)
     VALUES ($1, $2, $2, $3, 0, $4)`,
    [source, startedAt, rowsFound, status]
  );
}

test('getRecentMedian computes the median over only the most recent `limit` ok runs', async () => {
  const src = 'volchecktest_limit_' + Date.now();
  const now = Date.now();
  // 16 historical runs, rows_found = 1..16 in chronological order (oldest first).
  for (let i = 1; i <= 16; i++) {
    await insertRun(src, { rowsFound: i, startedAt: new Date(now - (20 - i) * 60_000) });
  }
  // Only the most recent 14 (values 3..16) should count → median of 3..16 = 9.5
  const med = await getRecentMedian(src, { before: new Date(now + 60_000), limit: 14 });
  assert.equal(med, 9.5);
});

test('getRecentMedian excludes runs at/after the `before` cutoff (today\'s own run)', async () => {
  const src = 'volchecktest_cutoff_' + Date.now();
  const now = Date.now();
  await insertRun(src, { rowsFound: 100, startedAt: new Date(now - 60_000) }); // yesterday-ish
  await insertRun(src, { rowsFound: 0, startedAt: new Date(now + 60_000) }); // today's own run, inserted already
  const med = await getRecentMedian(src, { before: new Date(now) });
  assert.equal(med, 100, 'the future/at-cutoff row must not be included in the baseline');
});

test('getRecentMedian ignores non-ok runs and null rows_found', async () => {
  const src = 'volchecktest_statusfilter_' + Date.now();
  const now = Date.now();
  await insertRun(src, { rowsFound: 50, startedAt: new Date(now - 10_000), status: 'ok' });
  await insertRun(src, { rowsFound: 9999, startedAt: new Date(now - 5_000), status: 'error' });
  const med = await getRecentMedian(src, { before: new Date(now + 60_000) });
  assert.equal(med, 50);
});

test('getRecentMedian returns null with no history', async () => {
  const med = await getRecentMedian('volchecktest_nohistory_' + Date.now());
  assert.equal(med, null);
});

test('evaluateVolume only evaluates summary entries with status ok, and flags drops', async () => {
  const srcOk = 'volchecktest_eval_ok_' + Date.now();
  const srcSkipped = 'volchecktest_eval_skipped_' + Date.now();
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    await insertRun(srcOk, { rowsFound: 100, startedAt: new Date(now - (10 - i) * 60_000) });
  }
  const summary = [
    { source: srcOk, found: 0, status: 'ok' },
    { source: srcSkipped, found: 999, status: 'error' }, // must be ignored
  ];
  const results = await evaluateVolume(summary, { before: new Date(now + 60_000) });
  assert.equal(results.length, 1, 'only the ok-status source is evaluated');
  assert.equal(results[0].source, srcOk);
  assert.equal(results[0].median, 100);
  assert.equal(results[0].warn, true);
});

test('CRITICAL_SOURCES includes the five sources named in the spec', () => {
  for (const s of ['recorder_nots', 'court_probate', 'court_divorce', 'phoenix_code', 'treasurer_delinquent']) {
    assert.ok(CRITICAL_SOURCES.has(s), `${s} should be a critical source`);
  }
});

// --- renderSourceHealthTable(): pure, no DB ---

test('renderSourceHealthTable renders one row per summary entry with found/median/status', () => {
  const summary = [
    { source: 'treasurer_delinquent', found: 200, status: 'ok' },
    { source: 'phoenix_code', found: 0, status: 'ok' },
    { source: 'code_mesa', found: 50, status: 'error' },
  ];
  const volumeResults = [
    { source: 'treasurer_delinquent', found: 200, median: 180, warn: false },
    { source: 'phoenix_code', found: 0, median: 300, warn: true },
  ];
  const table = renderSourceHealthTable(summary, volumeResults);
  assert.match(table, /## Source health/);
  assert.match(table, /\| treasurer_delinquent \| 200 \| 180 \| ok \|/);
  assert.match(table, /\| phoenix_code \| 0 \| 300 \| warn \|/);
  assert.match(table, /\| code_mesa \| — \| — \| error \|/);
});

test('renderSourceHealthTable omits adapters not present in the summary (e.g. --fast skips)', () => {
  const table = renderSourceHealthTable(
    [{ source: 'treasurer_delinquent', found: 10, status: 'ok' }],
    [{ source: 'treasurer_delinquent', found: 10, median: 10, warn: false }]
  );
  assert.doesNotMatch(table, /court_probate/);
});

after(async () => {
  // Scoped to this file's own prefix (not the shared 'test_' prefix used by
  // upsert.test.js) — node's test runner runs files concurrently, and a
  // shared broad wildcard caused cross-file deletes of in-flight rows.
  await query("DELETE FROM scrape_runs WHERE source LIKE 'volchecktest\\_%'");
  await pool.end();
});
