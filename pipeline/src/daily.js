/**
 * Daily pipeline: ingest all sources → resolve names/addresses → re-score →
 * write the Daily Motivated Report to reports/YYYY-MM-DD.md.
 *
 * Run: node src/daily.js            (all adapters)
 *      node src/daily.js --fast     (skip slow court walkers; recorder + APIs only)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAdapterGroups, SIGNAL_ADAPTERS } from './run.js';
import { resolveSignals } from './resolve.js';
import { computeScores } from './score.js';
import { dailyReport, reportCounts, renderMarkdown } from './report.js';
import { runMatchLeads } from './match-leads.js';
import { evaluateVolume, renderSourceHealthTable, CRITICAL_SOURCES } from './volume-check.js';
import { findTodaysRun } from './skip-if-ran.js';
import { pool, query } from './db.js';

// The 7 AM launchd run can fire while the Mac is still offline/asleep — the
// machine has been observed Power-Napping on and off for 20+ minutes right
// at run start (see pmset -g log). Tolerate up to 2h offline with capped
// backoff (15s → 2min) rather than a fixed small retry count, so a late wake
// (laptop closed overnight, wifi down) still produces a report instead of
// aborting the whole run.
async function waitForDb({ maxWaitMs = 2 * 60 * 60 * 1000, initialDelayMs = 15_000, maxDelayMs = 2 * 60 * 1000 } = {}) {
  const start = Date.now();
  let delay = initialDelayMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await query('SELECT 1');
      return true;
    } catch (e) {
      const elapsedMs = Date.now() - start;
      if (elapsedMs >= maxWaitMs) return false;
      console.log(`[daily] DB unreachable (attempt ${attempt}, ${Math.round(elapsedMs / 1000)}s elapsed): ${e.code ?? e.message} — retrying in ${Math.round(delay / 1000)}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, maxDelayMs);
    }
  }
}

// Every outbound fetch gets a hard timeout — a single hung request must never
// wedge the whole run (Aug 15 run hung 7 days on a city feed with no timeout).
// Bulk sources (treasurer/mesa/glendale) additionally retry transient
// failures with backoff (src/retry.js) — see pipeline CLAUDE.md for why a
// bigger timeout here is the wrong fix (it's laptop sleep killing in-flight
// requests, not a slow server).
const FETCH_TIMEOUT_MS = 60_000;
const _fetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) =>
  _fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS) });

// phoenix_code used to live here too: before the frontier-finding fix, a
// cold start walked from case #1 and could run for hours. It's now
// budget-capped (default 5000 requests/run) and resumes from scraper_state,
// so it behaves like the other bounded sources rather than an open-ended
// court backfill — --fast no longer needs to skip it.
const SLOW_WALKERS = new Set(['court_probate', 'court_divorce']);

const fast = process.argv.includes('--fast');
const adapters = fast
  ? SIGNAL_ADAPTERS.filter((a) => !SLOW_WALKERS.has(a.id))
  : SIGNAL_ADAPTERS;

console.log(`[daily] ${new Date().toISOString()} starting (${adapters.length} adapters${fast ? ', fast mode' : ''})`);

// --if-not-ran-today: the 08:23 Phoenix backstop cron's cheap no-op path.
// Runs before the lock and before waitForDb — if recorder_nots already
// completed (ok/warn) today Phoenix time, skip the whole run immediately
// rather than re-ingesting. If the DB isn't reachable for this check, fall
// through to a normal run (waitForDb below will handle real DB outages).
if (process.argv.includes('--if-not-ran-today')) {
  try {
    const existing = await findTodaysRun(query);
    if (existing) {
      console.log(`[daily] already ran today (${existing.started_at}) — skipping`);
      await pool.end();
      process.exit(0);
    }
  } catch (e) {
    console.log(`[daily] --if-not-ran-today pre-check failed (${e.message}) — falling through to normal run`);
  }
}

// Single-instance lock — a long backfill must not overlap the next scheduled run.
const LOCK = '/tmp/motivatedsignal-daily.lock';
try {
  const pid = Number(fs.readFileSync(LOCK, 'utf8'));
  if (pid) {
    try {
      process.kill(pid, 0); // throws if no such process
      console.log(`[daily] another run (pid ${pid}) is still active — exiting`);
      process.exit(0);
    } catch {
      // stale lock — previous run died; take over
    }
  }
} catch {
  // no lock file
}
fs.writeFileSync(LOCK, String(process.pid));
process.on('exit', () => {
  try { fs.unlinkSync(LOCK); } catch {}
});

if (!(await waitForDb())) {
  console.error('[daily] DB never became reachable within 2h — aborting run');
  await pool.end();
  process.exit(1);
}

// Whole-run watchdog: court backfills take hours, but nothing legitimate
// takes 8. Measured from when work actually starts (DB reachable), not from
// process launch — otherwise a long DB-wait during a late wake eats into the
// budget and a slow-to-wake machine would abort before producing a report.
const MAX_RUN_MS = 8 * 60 * 60 * 1000;
setTimeout(() => {
  console.error('[daily] watchdog: run exceeded 8h — aborting so the next scheduled run can start');
  process.exit(2);
}, MAX_RUN_MS).unref();

// Captured before adapters run so the volume check below can exclude today's
// own scrape_runs rows (already inserted by the time runAdapterGroups
// returns) when computing each source's historical median.
const runStartedAt = new Date();
const summary = await runAdapterGroups(adapters);
const failed = summary.filter((s) => s.status === 'error');
if (failed.length) {
  console.error(`[daily] ${failed.length} adapter(s) failed: ${failed.map((f) => f.source).join(', ')}`);
}

console.log('[daily] resolving…');
await resolveSignals();

console.log('[daily] scoring…');
await computeScores();

console.log('[daily] building report…');
const [rows, counts] = await Promise.all([dailyReport({ hours: 24 }), reportCounts({ hours: 24 })]);
const md = renderMarkdown(rows, counts, { hours: 24 });

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reports');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.md`);
fs.writeFileSync(file, md);
console.log(`[daily] report written: ${file}`);
console.log(md.split('\n').slice(0, 12).join('\n'));

// Outreach lead matching is a nice-to-have on top of the report — never let
// it fail the daily run (exit status is driven solely by adapter failures).
console.log('[daily] matching leads to prospects…');
try {
  await runMatchLeads({ days: 7 });
} catch (e) {
  console.error(`[daily] match-leads failed (non-fatal): ${e.message}`);
}

// Silent-zero / volume-collapse check — runs AFTER the report + match-leads
// are already written, so a tripped check still leaves today's output
// intact; it only changes the exit code (and, for a critical source, fails
// the job so GitHub emails the failure — see src/volume-check.js).
console.log('[daily] checking source volume…');
let criticalVolumeFailure = false;
let volumeResults = [];
try {
  volumeResults = await evaluateVolume(summary, { before: runStartedAt });
  for (const r of volumeResults) {
    if (!r.warn) continue;
    console.error(`[daily] VOLUME WARNING: ${r.source} found ${r.found} (14-run median ${r.median})`);
    const runEntry = summary.find((s) => s.source === r.source);
    if (runEntry?.runId) {
      try {
        await query('UPDATE scrape_runs SET status=$1 WHERE id=$2', ['warn', runEntry.runId]);
      } catch (e) {
        console.error(`[daily] failed to mark ${r.source} scrape_runs row as warn: ${e.message}`);
      }
    }
    if (CRITICAL_SOURCES.has(r.source)) criticalVolumeFailure = true;
  }
} catch (e) {
  console.error(`[daily] volume check failed (non-fatal): ${e.message}`);
}

const health = renderSourceHealthTable(summary, volumeResults);
fs.appendFileSync(file, '\n' + health);
console.log(health);

await pool.end();
let exitCode = 0;
if (failed.length) exitCode = 1;
else if (criticalVolumeFailure) exitCode = 2;
process.exit(exitCode);
