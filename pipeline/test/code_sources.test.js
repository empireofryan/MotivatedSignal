import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mapMesa } from '../src/sources/code_mesa.js';
import { mapGlendale } from '../src/sources/code_glendale.js';
import { mapTempe } from '../src/sources/code_tempe.js';
import { mapCounty } from '../src/sources/code_county.js';
import { mapScottsdale } from '../src/sources/code_scottsdale.js';

const load = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));

test('mapMesa maps Socrata rows', () => {
  const recs = mapMesa(load('code_mesa_sample.json'));
  assert.ok(recs.length > 0);
  const r = recs[0];
  assert.ok(r.externalId, 'must have externalId');
  assert.ok(r.raw, 'must have raw');
  assert.ok(r.apn || r.situsAddress, 'must have apn or situsAddress');
});

test('mapGlendale maps ArcGIS features', () => {
  const recs = mapGlendale(load('code_glendale_sample.json').features);
  assert.ok(recs.length > 0);
  const r = recs[0];
  assert.ok(r.externalId, 'must have externalId');
  assert.ok(r.raw, 'must have raw');
  assert.ok(r.apn || r.situsAddress, 'must have apn or situsAddress');
});

test('mapTempe maps ArcGIS features', () => {
  const recs = mapTempe(load('code_tempe_sample.json').features);
  assert.ok(recs.length > 0);
  const r = recs[0];
  assert.ok(r.externalId, 'must have externalId');
  assert.ok(r.raw, 'must have raw');
  assert.ok(r.apn || r.situsAddress, 'must have apn or situsAddress');
});

test('mapCounty maps ArcGIS features', () => {
  const recs = mapCounty(load('code_county_sample.json').features);
  assert.ok(recs.length > 0);
  const r = recs[0];
  assert.ok(r.externalId, 'must have externalId');
  assert.ok(r.raw, 'must have raw');
  assert.ok(r.apn || r.situsAddress, 'must have apn or situsAddress');
});

test('mapScottsdale maps ArcGIS features', () => {
  const recs = mapScottsdale(load('code_scottsdale_sample.json').features);
  assert.ok(recs.length > 0);
  const r = recs[0];
  assert.ok(r.externalId, 'must have externalId');
  assert.ok(r.raw, 'must have raw');
  assert.ok(r.apn || r.situsAddress, 'must have apn or situsAddress');
});
