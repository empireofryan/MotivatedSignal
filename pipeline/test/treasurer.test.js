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
  // apn is set to the normalized APN (same as externalId); no FK constraint
  assert.match(r.apn, /^[0-9A-Z]+$/);
  assert.equal(r.apn, r.externalId);
  assert.match(r.externalId, /^[0-9A-Z]+$/);
  assert.equal(typeof r.externalId, 'string');
  assert.ok(r.raw);
});
