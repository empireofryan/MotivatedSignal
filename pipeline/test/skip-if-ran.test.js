import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { phoenixDateString, phoenixDayBoundsUtc, findTodaysRun } from '../src/skip-if-ran.js';

describe('phoenixDateString', () => {
  test('converts a UTC morning timestamp to the Phoenix date', () => {
    // 13:00 UTC = 06:00 Phoenix (UTC-7) — same calendar day.
    assert.equal(phoenixDateString(new Date('2026-10-03T13:00:00Z')), '2026-10-03');
  });

  test('a UTC timestamp before 07:00 UTC is still the previous Phoenix day', () => {
    // 06:00 UTC = 23:00 Phoenix the prior day.
    assert.equal(phoenixDateString(new Date('2026-10-03T06:00:00Z')), '2026-10-02');
  });

  test('UTC midnight is mid-afternoon the previous Phoenix day', () => {
    assert.equal(phoenixDateString(new Date('2026-10-03T00:00:00Z')), '2026-10-02');
  });
});

describe('phoenixDayBoundsUtc', () => {
  test('returns a 24h [start, end) window anchored at Phoenix midnight', () => {
    const { start, end } = phoenixDayBoundsUtc(new Date('2026-10-03T13:00:00Z'));
    // Phoenix midnight on 2026-10-03 is 07:00 UTC same day.
    assert.equal(start.toISOString(), '2026-10-03T07:00:00.000Z');
    assert.equal(end.toISOString(), '2026-10-04T07:00:00.000Z');
    assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
  });

  test('a query time just before Phoenix midnight still falls inside the correct prior-day window', () => {
    const { start, end } = phoenixDayBoundsUtc(new Date('2026-10-03T06:59:00Z'));
    assert.equal(start.toISOString(), '2026-10-02T07:00:00.000Z');
    assert.equal(end.toISOString(), '2026-10-03T07:00:00.000Z');
  });
});

describe('findTodaysRun', () => {
  test('returns the row when the injected query finds one', async () => {
    let capturedSql, capturedParams;
    const queryFn = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [{ started_at: '2026-10-03T13:30:00.000Z' }] };
    };
    const now = new Date('2026-10-03T15:23:00Z');
    const result = await findTodaysRun(queryFn, { now });
    assert.deepEqual(result, { started_at: '2026-10-03T13:30:00.000Z' });

    assert.match(capturedSql, /status IN \('ok','warn'\)/);
    assert.equal(capturedParams[0], 'recorder_nots');
    assert.equal(capturedParams[1].toISOString(), '2026-10-03T07:00:00.000Z');
    assert.equal(capturedParams[2].toISOString(), '2026-10-04T07:00:00.000Z');
  });

  test('returns null when no row is found', async () => {
    const queryFn = async () => ({ rows: [] });
    const result = await findTodaysRun(queryFn, { now: new Date('2026-10-03T15:23:00Z') });
    assert.equal(result, null);
  });

  test('uses the given source instead of the default', async () => {
    let capturedParams;
    const queryFn = async (sql, params) => {
      capturedParams = params;
      return { rows: [] };
    };
    await findTodaysRun(queryFn, { source: 'court_probate', now: new Date('2026-10-03T15:23:00Z') });
    assert.equal(capturedParams[0], 'court_probate');
  });

  test('propagates a query rejection so callers can fall through to a normal run', async () => {
    const queryFn = async () => { throw new Error('DB unreachable'); };
    await assert.rejects(
      () => findTodaysRun(queryFn, { now: new Date() }),
      /DB unreachable/
    );
  });
});
