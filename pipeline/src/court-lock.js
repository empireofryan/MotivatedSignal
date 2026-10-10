/**
 * Cross-process mutex so the daily pipeline's court lane (court_probate +
 * court_divorce, run via run.js's runAdapterGroups) and court-retry.js never
 * walk the court site at the same time — the court rate-limits per IP, and
 * two walkers hitting it simultaneously would just make the busy spells worse
 * for both.
 *
 * daily.js and court-retry.js run as separate GitHub Actions jobs on
 * separate VMs, so there's no shared process/file-lock available — the only
 * thing they share is the database. This is a simple DB-row mutex (not a
 * true atomic lock), which is fine here: the two sides are scheduled minutes
 * apart, not racing at millisecond granularity, and a lost race just means
 * one side waits an extra poll cycle, not a correctness bug.
 */

import { getState, setState } from './state.js';

const LOCK_KEY = 'court_lock';

// A lock older than this is treated as abandoned (the holder crashed/was
// killed without releasing it) rather than honored forever — otherwise a
// single dead run could wedge every future court-retry/daily run.
export const STALE_MS = 20 * 60 * 1000;

/** Pure: is `lock` (the raw {running, holder, since} value) stale as of `now`? */
export function lockIsStale(lock, now = new Date()) {
  if (!lock?.since) return true;
  return now.getTime() - new Date(lock.since).getTime() >= STALE_MS;
}

/** Pure: is `lock` currently held (running and not stale) as of `now`? */
export function isLockActive(lock, now = new Date()) {
  return !!lock?.running && !lockIsStale(lock, now);
}

export async function isCourtLockHeld(now = new Date()) {
  const lock = await getState(LOCK_KEY);
  return isLockActive(lock, now);
}

async function acquire(holder) {
  await setState(LOCK_KEY, { running: true, holder, since: new Date().toISOString() });
}

async function release(holder) {
  await setState(LOCK_KEY, { running: false, holder, since: new Date().toISOString() });
}

/**
 * Wait (polling) for the lock to be free or stale, then acquire it, run
 * `fn()`, and release it afterward (even on error). Gives up waiting after
 * `maxWaitMs` and proceeds anyway — a bounded wait beats a deadlock between
 * two independently-scheduled jobs.
 */
export async function withCourtLock(holder, fn, { pollMs = 30_000, maxWaitMs = 20 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (await isCourtLockHeld()) {
    if (Date.now() - start >= maxWaitMs) {
      console.warn(`[court-lock] ${holder}: gave up waiting for the lock after ${Math.round((Date.now() - start) / 1000)}s — proceeding anyway`);
      break;
    }
    console.log(`[court-lock] ${holder}: lock held by another run — waiting ${pollMs / 1000}s`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  await acquire(holder);
  try {
    return await fn();
  } finally {
    await release(holder);
  }
}
