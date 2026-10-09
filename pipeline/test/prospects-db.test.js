import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractAddressFromNotes } from '../src/prospects-db.js';

describe('extractAddressFromNotes()', () => {
  it('extracts city/zip from an explicit AZ street address', () => {
    assert.deepEqual(
      extractAddressFromNotes('Founder Jared Vidales. Office: 2410 E Osborn Rd Ste 200, Phoenix, AZ 85016'),
      { city: 'Phoenix', zip: '85016' }
    );
  });

  it('handles a multi-word city name', () => {
    assert.deepEqual(
      extractAddressFromNotes('Office: 1306 SW 4th Ave, Battle Ground, WA 98604. Operates in Chandler, AZ area'),
      null // out-of-state address, deliberately not extracted
    );
  });

  it('picks the city immediately preceding the state/zip, not an earlier comma-separated word', () => {
    assert.deepEqual(
      extractAddressFromNotes('Office: 2390 E Camelback Rd, Suite 130, Phoenix, AZ 85016. Hours: 7am-11pm daily'),
      { city: 'Phoenix', zip: '85016' }
    );
  });

  it('returns null when there is no zip present', () => {
    assert.equal(
      extractAddressFromNotes('Office: 2600 N Central Ave Ste 610, Phoenix, AZ. Juan Cruz is prominent contact'),
      null
    );
  });

  it('returns null when there is no address at all', () => {
    assert.equal(extractAddressFromNotes('Founded 2006, Mesa-based, 5000+ loans funded, $1B+ volume'), null);
  });

  it('returns null for null/empty notes', () => {
    assert.equal(extractAddressFromNotes(null), null);
    assert.equal(extractAddressFromNotes(''), null);
  });
});
