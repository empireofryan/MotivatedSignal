import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectBatch, selectionTier, rampN, remainingToSend, evaluateStop, phoenixDateString, phoenixDayBoundsUtc,
} from '../lib/outreach-logic.ts';

const c = (o) => ({
  id: 1, rank: 1, segment: 'wholesaler', email: 'a@b.com', status: 'new', variant: 'A',
  inboxFlag: null, matchTiers: ['any', 'any'], alreadySent: false, ...o,
});

test('tiers: zip/city first, lenders second, rest by rank', () => {
  const list = [
    c({ id: 1, rank: 1 }),
    c({ id: 2, rank: 5, segment: 'lender' }),
    c({ id: 3, rank: 9, matchTiers: ['any', 'zip'] }),
    c({ id: 4, rank: 3, segment: 'lender', matchTiers: ['city', 'any'] }),
    c({ id: 5, rank: 2 }),
  ];
  assert.deepEqual(selectBatch(list, 10).map((x) => x.id), [4, 3, 2, 1, 5]);
  assert.equal(selectionTier(list[3]), 0);
  assert.equal(selectionTier(list[1]), 1);
});

test('filters: status, email, flags, community_leader, variant, already sent', () => {
  const list = [
    c({ id: 1, status: 'sent' }),
    c({ id: 2, email: null }),
    c({ id: 3, inboxFlag: 'shared' }),
    c({ id: 4, inboxFlag: 'third-party' }),
    c({ id: 5, segment: 'community_leader' }),
    c({ id: 6, variant: null }),
    c({ id: 7, alreadySent: true }),
    c({ id: 8 }),
  ];
  assert.deepEqual(selectBatch(list, 10).map((x) => x.id), [8]);
});

test('selectBatch respects n', () => {
  const list = [c({ id: 1, rank: 1 }), c({ id: 2, rank: 2 }), c({ id: 3, rank: 3 })];
  assert.equal(selectBatch(list, 2).length, 2);
  assert.equal(selectBatch(list, 0).length, 0);
});

test('ramp: 10 for first 5 send days then 15, override clamped to 20', () => {
  assert.equal(rampN(0), 10);
  assert.equal(rampN(4), 10);
  assert.equal(rampN(5), 15);
  assert.equal(rampN(30), 15);
  assert.equal(rampN(30, 3), 3);
  assert.equal(rampN(0, 99), 20);
  assert.equal(rampN(0, 0), 10);
  assert.equal(rampN(0, NaN), 10);
});

test('remainingToSend subtracts today and caps at 20', () => {
  assert.equal(remainingToSend(10, 0, false), 10);
  assert.equal(remainingToSend(10, 10, false), 0);
  assert.equal(remainingToSend(10, 4, false), 6);
  assert.equal(remainingToSend(3, 4, true), 3);
  assert.equal(remainingToSend(20, 15, true), 5);
  assert.equal(remainingToSend(15, 25, false), 0);
});

test('stop logic', () => {
  const base = { stopsSincePrevSendDay: 0, bouncesSincePrevSendDay: 0, sentTotal: 100, bouncedTotal: 3 };
  assert.equal(evaluateStop(base).halt, false);
  assert.equal(evaluateStop({ ...base, sentTotal: 0, bouncedTotal: 0 }).halt, false);
  assert.equal(evaluateStop({ ...base, stopsSincePrevSendDay: 1 }).halt, true);
  assert.equal(evaluateStop({ ...base, bouncesSincePrevSendDay: 1 }).halt, true);
  assert.equal(evaluateStop({ ...base, bouncedTotal: 4 }).halt, true);
});

test('phoenix day bounds are 24h and start at 07:00Z', () => {
  const { start, end } = phoenixDayBoundsUtc(new Date('2026-10-26T16:45:00Z'));
  assert.equal(phoenixDateString(new Date('2026-10-26T16:45:00Z')), '2026-10-26');
  assert.equal(start.toISOString(), '2026-10-26T07:00:00.000Z');
  assert.equal(end.getTime() - start.getTime(), 86400000);
});
