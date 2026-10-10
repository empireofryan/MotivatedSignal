import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isCourtOutageWindow, phoenixTimeLabel, buildProbeUrl, courtsCompleteToday } from '../src/court-retry.js';

describe('isCourtOutageWindow', () => {
  test('Tuesday 03:30 Phoenix is inside the outage window', () => {
    // 10:30 UTC = 03:30 Phoenix (UTC-7)
    assert.equal(isCourtOutageWindow(new Date('2026-10-13T10:30:00Z')), true);
  });

  test('Tuesday 02:59 Phoenix is just before the window', () => {
    assert.equal(isCourtOutageWindow(new Date('2026-10-13T09:59:00Z')), false);
  });

  test('Tuesday 04:00 Phoenix is just after the window (end exclusive)', () => {
    assert.equal(isCourtOutageWindow(new Date('2026-10-13T11:00:00Z')), false);
  });

  test('Sunday 03:30 Phoenix is outside the window (only Tue-Sat are offline)', () => {
    // 2026-10-11 is a Sunday
    assert.equal(isCourtOutageWindow(new Date('2026-10-11T10:30:00Z')), false);
  });

  test('Monday 03:30 Phoenix is outside the window', () => {
    // 2026-10-12 is a Monday
    assert.equal(isCourtOutageWindow(new Date('2026-10-12T10:30:00Z')), false);
  });

  test('Saturday 03:30 Phoenix is inside the window (last offline day)', () => {
    // 2026-10-17 is a Saturday
    assert.equal(isCourtOutageWindow(new Date('2026-10-17T10:30:00Z')), true);
  });

  test('a mid-afternoon timestamp any weekday is outside the window', () => {
    assert.equal(isCourtOutageWindow(new Date('2026-10-13T20:00:00Z')), false); // 13:00 Phoenix
  });
});

describe('phoenixTimeLabel', () => {
  test('formats as HH:MM in Phoenix local time', () => {
    assert.equal(phoenixTimeLabel(new Date('2026-10-13T18:04:00Z')), '11:04'); // 18:04 UTC = 11:04 Phoenix
  });
});

describe('buildProbeUrl', () => {
  test('pads the case number to 6 digits', () => {
    assert.equal(
      buildProbeUrl('https://example.test/caseInfo.asp?caseNumber=', 2026, 42),
      'https://example.test/caseInfo.asp?caseNumber=PB2026-000042'
    );
  });

  test('does not truncate a case number already 6+ digits', () => {
    assert.equal(
      buildProbeUrl('https://example.test/caseInfo.asp?caseNumber=', 2026, 123456),
      'https://example.test/caseInfo.asp?caseNumber=PB2026-123456'
    );
  });
});

describe('courtsCompleteToday', () => {
  test('true when both sources have a clean ok row today', async () => {
    const queryFn = async (_sql, params) => {
      const source = params[0];
      if (source === 'court_divorce' || source === 'court_probate') {
        return { rows: [{ started_at: '2026-10-13T15:30:00.000Z' }] };
      }
      return { rows: [] };
    };
    const now = new Date('2026-10-13T16:00:00Z');
    assert.equal(await courtsCompleteToday(queryFn, { now }), true);
  });

  test('false when one source has no row today', async () => {
    let call = 0;
    const queryFn = async () => {
      call++;
      // court_divorce (checked first) found, court_probate not
      return call === 1 ? { rows: [{ started_at: '2026-10-13T15:30:00.000Z' }] } : { rows: [] };
    };
    const now = new Date('2026-10-13T16:00:00Z');
    assert.equal(await courtsCompleteToday(queryFn, { now }), false);
  });

  test('excludes busy-stop rows via the SQL predicate', async () => {
    let capturedSql;
    const queryFn = async (sql) => {
      capturedSql = sql;
      return { rows: [] };
    };
    await courtsCompleteToday(queryFn, { now: new Date('2026-10-13T16:00:00Z') });
    assert.match(capturedSql, /error IS NULL OR error != 'busy-stop'/);
  });

  test('checks both court_divorce and court_probate', async () => {
    const seenSources = [];
    const queryFn = async (_sql, params) => {
      seenSources.push(params[0]);
      return { rows: [{ started_at: '2026-10-13T15:30:00.000Z' }] };
    };
    await courtsCompleteToday(queryFn, { now: new Date('2026-10-13T16:00:00Z') });
    assert.deepEqual(seenSources, ['court_divorce', 'court_probate']);
  });

  test('propagates a query rejection so callers can fall through', async () => {
    const queryFn = async () => { throw new Error('DB unreachable'); };
    await assert.rejects(() => courtsCompleteToday(queryFn, { now: new Date() }), /DB unreachable/);
  });
});
