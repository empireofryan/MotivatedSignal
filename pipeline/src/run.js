import { upsertSignals, recordRun } from './upsert.js';
import { pool } from './db.js';
import { withRetry } from './retry.js';
import { withCourtLock } from './court-lock.js';
import treasurerDelinquent from './sources/treasurer.js';
import codeMesa from './sources/code_mesa.js';
import codeGlendale from './sources/code_glendale.js';
import codeTempe from './sources/code_tempe.js';
import codeCounty from './sources/code_county.js';
import codeScottsdale from './sources/code_scottsdale.js';
import phoenixCode from './sources/phoenix_code.js';
import recorderNots from './sources/recorder_nots.js';
import courtProbate from './sources/court_probate.js';
import courtDivorce from './sources/court_divorce.js';
import { recorderLisPendens, recorderMechanicsLien, recorderNonGovtLien } from './sources/recorder_liens.js';

export async function runAdapters(adapters) {
  const summary = [];
  for (const adapter of adapters) {
    const startedAt = new Date();
    try {
      const records = await adapter.fetch({});
      // The fetch is often the expensive/slow part (minutes of pagination);
      // don't let a transient DB blip (e.g. "Connection terminated
      // unexpectedly" from a mid-run laptop sleep) throw away a fully-fetched
      // batch — retry the upsert (idempotent on source+external_id) a few times.
      const { found: emittedFound, inserted } = await withRetry(
        () => upsertSignals(records, { signalType: adapter.signalType, source: adapter.id }),
        {
          retries: 4,
          baseDelayMs: 5_000,
          maxDelayMs: 60_000,
          onRetry: ({ attempt, retries, delay, error }) =>
            console.log(`[${adapter.id}] upsert retry ${attempt}/${retries} in ${(delay / 1000).toFixed(1)}s (${error.message})`),
        }
      );
      // Recorder adapters (see recorder_common.js) skip re-fetching already-stored recording
      // numbers, so `records` only covers the not-yet-stored subset — but `found` should still
      // reflect Phase 1's full discovery count for volume-check.js's drop detection to stay
      // meaningful. Adapters that opt into this set `.foundCount` on the returned array.
      const found = records.foundCount ?? emittedFound;
      const sourceMaxDate = records.reduce(
        (m, r) => (r.eventDate && (!m || r.eventDate > m) ? r.eventDate : m),
        null
      );
      // Court walkers (court_probate/court_divorce) set .stoppedOnBusy on the
      // returned array when they gave up because the court backend was still
      // busy, not because they ran off the end of real cases — that's an
      // incomplete run worth retrying (see court-retry.js), distinct from a
      // normal status='error'. Recorded as scrape_runs.error='busy-stop'
      // (status stays 'ok' — it's not a failure, just unfinished) so a
      // same-day completeness check can tell the two apart without a schema
      // change.
      const stoppedOnBusy = records.stoppedOnBusy ?? false;
      const runId = await recordRun({ source: adapter.id, startedAt, finishedAt: new Date(),
        rowsFound: found, rowsNew: inserted, status: 'ok', sourceMaxDate,
        error: stoppedOnBusy ? 'busy-stop' : null });
      summary.push({ source: adapter.id, found, inserted, status: 'ok', runId, stoppedOnBusy });
      console.log(`[${adapter.id}] ${found} found, ${inserted} new${stoppedOnBusy ? ' (stopped on busy)' : ''}`);
    } catch (e) {
      // recordRun itself can fail (e.g. network drop mid-run) — never let the
      // run logger kill the remaining adapters.
      try {
        await recordRun({ source: adapter.id, startedAt, finishedAt: new Date(),
          status: 'error', error: String(e).slice(0, 500) });
      } catch (logErr) {
        console.error(`[${adapter.id}] recordRun failed: ${logErr.message}`);
      }
      summary.push({ source: adapter.id, status: 'error', error: String(e) });
      console.error(`[${adapter.id}] ERROR: ${e}`);
    }
  }
  return summary;
}

/**
 * Run adapters in parallel lanes, one lane per remote host, sequential within
 * a lane (per-host throttles stay honest). Wall-clock = slowest lane.
 */
export async function runAdapterGroups(adapters, { lockHolder = 'daily' } = {}) {
  const lanes = new Map();
  for (const a of adapters) {
    const lane = a.id.startsWith('recorder') ? 'recorder'
      : a.id.startsWith('court') ? 'court'
      : a.id;
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push(a);
  }
  console.log(`[run] ${adapters.length} adapters across ${lanes.size} parallel lanes`);
  const results = await Promise.all(
    [...lanes.entries()].map(([lane, group]) =>
      // The 'court' lane shares a rate-limited backend with court-retry.js's
      // standalone retry runs — see court-lock.js — so it's the only lane
      // that needs cross-process mutual exclusion. `lockHolder` is just a
      // debugging label; court-retry.js passes 'court-retry' here so
      // [court-lock] log lines say who's holding it.
      lane === 'court' ? withCourtLock(lockHolder, () => runAdapters(group)) : runAdapters(group)
    )
  );
  return results.flat();
}

// Registry filled in as adapters land. Assessor runs separately (writes properties, not signals).
export const SIGNAL_ADAPTERS = [treasurerDelinquent, codeMesa, codeGlendale, codeTempe, codeCounty, codeScottsdale, phoenixCode, recorderNots, courtDivorce, courtProbate, recorderLisPendens, recorderMechanicsLien, recorderNonGovtLien];

if (import.meta.url === `file://${process.argv[1]}`) {
  runAdapters(SIGNAL_ADAPTERS).then(() => pool.end());
}
