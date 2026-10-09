import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { topLeads } from '../src/leads.js';
import { pool } from '../src/db.js';

after(() => pool.end());

describe('topLeads()', () => {
  it('returns ≤5 rows sorted by score DESC with expected keys', async () => {
    const rows = await topLeads({ limit: 5 });
    assert.ok(rows.length <= 5, `expected ≤5, got ${rows.length}`);
    assert.ok(rows.length > 0, 'expected at least one row');

    // Verify sorted descending
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].score >= rows[i].score, 'rows not sorted by score DESC');
    }

    // Verify expected keys on first row
    const expected = ['apn', 'score', 'hot', 'signalTypes', 'ownerName', 'situsAddress', 'mailingAddress', 'absentee', 'components'];
    for (const key of expected) {
      assert.ok(key in rows[0], `missing key: ${key}`);
    }

    // score should be a number
    assert.equal(typeof rows[0].score, 'number', 'score should be a number');
  });

  it('topLeads({hotOnly:true}) returns only hot rows', async () => {
    const rows = await topLeads({ hotOnly: true, limit: 10 });
    assert.ok(rows.length > 0, 'expected hot rows');
    for (const row of rows) {
      assert.equal(row.hot, true, `non-hot row returned: ${row.apn}`);
    }
  });

  it('topLeads({minScore:80}) returns only rows with score>=80', async () => {
    const rows = await topLeads({ minScore: 80, limit: 10 });
    assert.ok(rows.length > 0, 'expected rows with score>=80');
    for (const row of rows) {
      assert.ok(row.score >= 80, `row score ${row.score} < 80`);
    }
  });
});
