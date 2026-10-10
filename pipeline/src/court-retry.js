/**
 * court-retry.js — keep retrying the Maricopa Superior Court docket
 * (court_divorce, then court_probate) every few minutes until it's
 * reachable, instead of settling for the daily pipeline's single attempt at
 * 08:00/18:00 Phoenix landing squarely in a "Server busy" spell.
 *
 * Loop: cheap single-shot probe (one known-existing case) → if busy, sleep
 * 4 min and probe again → once a probe succeeds, run both walkers at their
 * normal budgets via the same upsert/recordRun path as run.js. If either
 * walker's run was itself cut short by busy (not by running out of real
 * cases), that's still incomplete — loop back to probing. Stops when both
 * walkers complete a run without hitting their busy-streak stop, or after
 * --max-minutes (default 300 = 5h; the GitHub Actions job gives it 330).
 *
 * Shares the court site and the DB with the daily pipeline's own court lane
 * — see court-lock.js for how the two avoid walking at the same time, and
 * run.js/court_probate.js/court_divorce.js for stoppedOnBusy / 'busy-stop'.
 *
 * Run: node src/court-retry.js [--max-minutes 300]
 */

import { pool, query } from './db.js';
import { getState } from './state.js';
import { probeOnce } from './courtfetch.js';
import { runAdapterGroups } from './run.js';
import { isCourtLockHeld } from './court-lock.js';
import { resolveSignals } from './resolve.js';
import { computeScores } from './score.js';
import { runMatchLeads } from './match-leads.js';
import { phoenixDayBoundsUtc } from './skip-if-ran.js';
import courtProbate, { BASE as PROBATE_BASE } from './sources/court_probate.js';
import courtDivorce from './sources/court_divorce.js';

// --- Pure helpers (exported for tests) --------------------------------

// Confirmed offline window (see CLAUDE.md Phase 5): the docket backend goes
// down Tue–Sat 03:00–04:00 Phoenix for maintenance. America/Phoenix doesn't
// observe DST, so this is a fixed window year-round.
const OUTAGE_DAYS = new Set(['Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const OUTAGE_HOUR = 3;

export function isCourtOutageWindow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix',
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  return OUTAGE_DAYS.has(weekday) && hour === OUTAGE_HOUR;
}

export function phoenixTimeLabel(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export function buildProbeUrl(baseUrl, year, n) {
  return `${baseUrl}PB${year}-${String(n).padStart(6, '0')}`;
}

const COURT_SOURCES = ['court_divorce', 'court_probate'];

/**
 * Have both court sources already completed (status ok, and NOT a
 * busy-stop) a run today, Phoenix time? If so there's nothing for
 * court-retry to do — the primary/catchup run already got through.
 * `queryFn` is injected so this is unit-testable without a DB (same pattern
 * as skip-if-ran.js's findTodaysRun); callers should treat a rejected
 * promise as "couldn't check" and proceed rather than as "not done".
 */
export async function courtsCompleteToday(queryFn, { now = new Date() } = {}) {
  const { start, end } = phoenixDayBoundsUtc(now);
  for (const source of COURT_SOURCES) {
    const { rows } = await queryFn(
      `SELECT started_at FROM scrape_runs
       WHERE source = $1 AND status = 'ok' AND (error IS NULL OR error != 'busy-stop')
         AND started_at >= $2 AND started_at < $3
       ORDER BY started_at DESC LIMIT 1`,
      [source, start, end]
    );
    if (!rows.length) return false;
  }
  return true;
}

function argValue(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return def;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

async function sleepCapped(ms, deadline) {
  const wait = Math.max(0, Math.min(ms, deadline - Date.now()));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function waitForDb({ retries = 5, delayMs = 10_000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      await query('SELECT 1');
      return true;
    } catch (e) {
      console.log(`[court-retry] DB not ready (${e.code ?? e.message}) — retry ${i + 1}/${retries}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/** Probe one known-existing case: probate's saved resume high-water mark, or case #1 if there's none yet. */
async function probeCourt() {
  const year = new Date().getFullYear();
  let lastN = 1;
  try {
    const st = await getState(`court_probate:PB${year}`);
    if (st?.lastN) lastN = st.lastN;
  } catch {
    // no DB state available — fall back to case #1
  }
  return probeOnce(buildProbeUrl(PROBATE_BASE, year, lastN));
}

async function main() {
  const maxMinutes = argValue('--max-minutes', 300);
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  console.log(`[court-retry] ${new Date().toISOString()} starting (max ${maxMinutes}m)`);

  if (!(await waitForDb())) {
    console.error('[court-retry] DB never became reachable — aborting');
    await pool.end();
    process.exit(1);
  }

  try {
    if (await courtsCompleteToday(query)) {
      console.log('[court-retry] courts already complete today');
      await pool.end();
      process.exit(0);
    }
  } catch (e) {
    console.log(`[court-retry] completeness pre-check failed (${e.message}) — proceeding`);
  }

  let probes = 0;
  let timedOutBusy = false;
  let finalSummary = null;

  for (;;) {
    if (Date.now() >= deadline) {
      timedOutBusy = true;
      break;
    }

    if (isCourtOutageWindow()) {
      console.log(`[court-retry] ${phoenixTimeLabel()} in the 3–4am Phoenix maintenance window — sleeping`);
      await sleepCapped(10 * 60 * 1000, deadline);
      continue;
    }

    let lockHeld = false;
    try {
      lockHeld = await isCourtLockHeld();
    } catch (e) {
      console.log(`[court-retry] lock check failed (${e.message}) — assuming free`);
    }
    if (lockHeld) {
      console.log(`[court-retry] ${phoenixTimeLabel()} the daily run is already walking the court — waiting`);
      await sleepCapped(60_000, deadline);
      continue;
    }

    probes++;
    const probe = await probeCourt();
    if (probe.status === 'busy') {
      const nextAt = phoenixTimeLabel(new Date(Math.min(Date.now() + 4 * 60 * 1000, deadline)));
      console.log(`[court-retry] ${phoenixTimeLabel()} busy, next probe ${nextAt}`);
      await sleepCapped(4 * 60 * 1000, deadline);
      continue;
    }

    console.log(`[court-retry] ${phoenixTimeLabel()} court responded — running walkers (probe #${probes})`);
    const summary = await runAdapterGroups([courtDivorce, courtProbate], { lockHolder: 'court-retry' });
    finalSummary = summary;
    for (const s of summary) {
      console.log(
        s.status === 'ok'
          ? `[court-retry]   ${s.source}: ok, ${s.found} found / ${s.inserted} new${s.stoppedOnBusy ? ' (busy-stop, incomplete)' : ''}`
          : `[court-retry]   ${s.source}: error (${s.error})`
      );
    }

    const anyNew = summary.some((s) => s.status === 'ok' && s.inserted > 0);
    if (anyNew) {
      console.log('[court-retry] new court rows — resolving + scoring + matching leads');
      try {
        await resolveSignals();
        await computeScores();
        await runMatchLeads({ days: 7 });
      } catch (e) {
        console.error(`[court-retry] post-processing failed (non-fatal): ${e.message}`);
      }
    }

    const incomplete = summary.some((s) => s.status !== 'ok' || s.stoppedOnBusy);
    if (!incomplete) {
      console.log('[court-retry] both walkers completed cleanly — done');
      break;
    }
    console.log('[court-retry] still incomplete (hit busy mid-run) — will retry');
    await sleepCapped(4 * 60 * 1000, deadline);
  }

  const elapsedMin = Math.round((maxMinutes * 60 * 1000 - Math.max(0, deadline - Date.now())) / 60000);
  if (timedOutBusy) {
    console.log(`[court-retry] STILL BUSY after ${elapsedMin} min (${probes} probes) — giving up for this run`);
  } else {
    console.log(`[court-retry] summary: ${probes} probe(s), ${elapsedMin} min elapsed, result=${JSON.stringify(
      (finalSummary ?? []).map((s) => ({ source: s.source, status: s.status, inserted: s.inserted ?? 0 }))
    )}`);
  }

  await pool.end();
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[court-retry] fatal: ${e.stack ?? e}`);
    process.exit(1);
  });
}
