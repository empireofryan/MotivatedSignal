import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceWalk } from '../src/courtfetch.js';

const OPTS = { maxBusyStreak: 3, missStop: 3 };

test('advanceWalk: busy increments busyStreak and leaves misses alone', () => {
  const r = advanceWalk('busy', { busyStreak: 0, misses: 2 }, OPTS);
  assert.equal(r.busyStreak, 1);
  assert.equal(r.misses, 2);
  assert.equal(r.stop, false);
});

test('advanceWalk: busyStreak hitting maxBusyStreak signals stop', () => {
  const r = advanceWalk('busy', { busyStreak: 2, misses: 0 }, OPTS);
  assert.equal(r.busyStreak, 3);
  assert.equal(r.stop, true);
});

test('advanceWalk: busy never counts toward missStop even near the cap', () => {
  const r = advanceWalk('busy', { busyStreak: 0, misses: 2 }, OPTS); // misses already 1 short of missStop
  assert.equal(r.stop, false, 'busy alone must not trip missStop');
  assert.equal(r.misses, 2, 'misses must not be incremented by a busy response');
});

test('advanceWalk: a miss after a busy streak clears the busy streak and counts as a miss', () => {
  const r = advanceWalk('miss', { busyStreak: 2, misses: 0 }, OPTS);
  assert.equal(r.busyStreak, 0);
  assert.equal(r.misses, 1);
  assert.equal(r.stop, false);
});

test('advanceWalk: misses hitting missStop signals stop, independent of busy', () => {
  const r = advanceWalk('miss', { busyStreak: 0, misses: 2 }, OPTS);
  assert.equal(r.misses, 3);
  assert.equal(r.stop, true);
});

test('advanceWalk: ok clears both streaks and never stops', () => {
  const r = advanceWalk('ok', { busyStreak: 2, misses: 2 }, OPTS);
  assert.equal(r.busyStreak, 0);
  assert.equal(r.misses, 0);
  assert.equal(r.stop, false);
});

test('advanceWalk: a busy spell that resolves before maxBusyStreak lets the walk continue cleanly', () => {
  let state = { busyStreak: 0, misses: 0 };
  for (const status of ['busy', 'busy', 'ok', 'busy', 'busy']) {
    state = advanceWalk(status, state, OPTS);
    assert.equal(state.stop, false, `should not stop on ${status} mid-sequence`);
  }
  // The two 'busy' after the 'ok' reset only reach streak 2 (< maxBusyStreak 3).
  assert.equal(state.busyStreak, 2);
});
