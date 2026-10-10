import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { lockIsStale, isLockActive, STALE_MS } from '../src/court-lock.js';

describe('lockIsStale', () => {
  test('a lock with no since is treated as stale', () => {
    assert.equal(lockIsStale(null), true);
    assert.equal(lockIsStale({ running: true }), true);
  });

  test('a fresh lock is not stale', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const lock = { running: true, since: '2026-10-13T11:58:00Z' }; // 2 min ago
    assert.equal(lockIsStale(lock, now), false);
  });

  test('a lock older than STALE_MS is stale', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const since = new Date(now.getTime() - STALE_MS - 1000).toISOString();
    assert.equal(lockIsStale({ running: true, since }, now), true);
  });

  test('a lock exactly at STALE_MS is stale (boundary is inclusive)', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const since = new Date(now.getTime() - STALE_MS).toISOString();
    assert.equal(lockIsStale({ running: true, since }, now), true);
  });
});

describe('isLockActive', () => {
  test('null lock is not active', () => {
    assert.equal(isLockActive(null), false);
  });

  test('running=false is not active even if fresh', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    assert.equal(isLockActive({ running: false, since: now.toISOString() }, now), false);
  });

  test('running=true and fresh is active', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const lock = { running: true, since: '2026-10-13T11:59:00Z' };
    assert.equal(isLockActive(lock, now), true);
  });

  test('running=true but stale is not active', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const since = new Date(now.getTime() - STALE_MS - 1000).toISOString();
    assert.equal(isLockActive({ running: true, since }, now), false);
  });
});
