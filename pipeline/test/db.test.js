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
