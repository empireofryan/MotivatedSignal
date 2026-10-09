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

test('upsertSignals handles mixed batch with in-batch duplicate and re-run', async () => {
  const src = 'test_src3_' + Date.now();
  // Pre-insert one record
  await upsertSignals([{ externalId: 'C1', raw: {}, status: 'open' }], { signalType: 'code_violation', source: src });
  // Batch of 3: C1 (already present), C2 (new), C2 (duplicate within batch — should count once)
  const mixed = [
    { externalId: 'C1', raw: {}, status: 'open' },
    { externalId: 'C2', raw: {}, status: 'open' },
    { externalId: 'C2', raw: {}, status: 'open' },
  ];
  const first = await upsertSignals(mixed, { signalType: 'code_violation', source: src });
  assert.equal(first.found, 3, 'found should equal records.length');
  assert.equal(first.inserted, 1, 'only C2 is new');
  // Re-run same batch → inserted must be 0
  const second = await upsertSignals(mixed, { signalType: 'code_violation', source: src });
  assert.equal(second.inserted, 0, 're-run yields 0 inserts');
  // DB should have exactly 2 distinct rows
  const r = await query('SELECT count(*) FROM signals WHERE source=$1', [src]);
  assert.equal(Number(r.rows[0].count), 2);
});

test('upsertSignals COALESCE protects non-null apn on re-upsert', async () => {
  const src = 'test_apn_coalesce_' + Date.now();
  // 1. Insert with apn=null
  await upsertSignals([{ externalId: 'APN1', apn: null, raw: {}, status: 'open' }], { signalType: 'tax_delinquent', source: src });
  const r1 = await query('SELECT apn FROM signals WHERE source=$1 AND external_id=$2', [src, 'APN1']);
  assert.equal(r1.rows[0].apn, null, 'initial insert: apn should be null');

  // 2. Upsert with a non-null apn → row's apn becomes non-null
  await upsertSignals([{ externalId: 'APN1', apn: '12345678', raw: {}, status: 'open' }], { signalType: 'tax_delinquent', source: src });
  const r2 = await query('SELECT apn FROM signals WHERE source=$1 AND external_id=$2', [src, 'APN1']);
  assert.equal(r2.rows[0].apn, '12345678', 'after upsert with apn: apn should be set');

  // 3. Upsert again with apn=null → COALESCE keeps the non-null value
  await upsertSignals([{ externalId: 'APN1', apn: null, raw: {}, status: 'open' }], { signalType: 'tax_delinquent', source: src });
  const r3 = await query('SELECT apn FROM signals WHERE source=$1 AND external_id=$2', [src, 'APN1']);
  assert.equal(r3.rows[0].apn, '12345678', 'COALESCE should preserve non-null apn when incoming is null');
});

test('recordRun inserts a run row', async () => {
  const src = 'test_run_' + Date.now();
  await recordRun({ source: src, startedAt: new Date(), finishedAt: new Date(), rowsFound: 5, rowsNew: 2, status: 'ok' });
  const r = await query('SELECT rows_found FROM scrape_runs WHERE source=$1', [src]);
  assert.equal(Number(r.rows[0].rows_found), 5);
});

after(async () => {
  // Clean up all test rows to avoid polluting the live production DB
  await query("DELETE FROM signals WHERE source LIKE 'test\\_%'");
  await query("DELETE FROM scrape_runs WHERE source LIKE 'test\\_%'");
  await pool.end();
});
