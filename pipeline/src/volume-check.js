/**
 * Silent-zero detection: an adapter that reports status 'ok' but found far
 * fewer rows than usual (or exactly 0) is usually a broken scraper, not a
 * genuinely quiet day — see phoenix_code's "ok, 0 found" streak from
 * 2026-06-23 onward, which no one noticed because the run still exited 0.
 *
 * This compares today's found count per source against the median of that
 * source's last 14 'ok' runs (excluding today) and flags a drop.
 */

import { query } from './db.js';

// Sources whose daily operation we actively depend on for lead volume — a
// silent-zero on any of these should fail the GitHub Actions job so GitHub
// emails the failure. (Code-violation city feeds and the ArcGIS sources are
// bulk/API pulls that are less likely to silently break the same way, so
// they're tracked in the health table but don't trip the hard exit.)
export const CRITICAL_SOURCES = new Set([
  'recorder_nots',
  'court_probate',
  'court_divorce',
  'phoenix_code',
  'treasurer_delinquent',
]);

/** Median of a list of numbers, or null for an empty list. */
export function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Pure drop-detection rule, given today's found count and the historical
 * median:
 *   - no baseline (median null or 0) → never warn, nothing to compare against
 *   - found === 0 and median > 0 → warn (silent zero)
 *   - median >= 50 and found < 10% of median → warn (volume collapse)
 *   - otherwise → ok
 */
export function isVolumeDrop(found, medianVal) {
  if (medianVal == null || medianVal <= 0) return false;
  if (found === 0) return true;
  if (medianVal >= 50 && found < medianVal * 0.1) return true;
  return false;
}

/** Median rows_found over a source's last `limit` 'ok' runs started before `before`. */
export async function getRecentMedian(source, { before = new Date(), limit = 14 } = {}) {
  const { rows } = await query(
    `SELECT rows_found FROM scrape_runs
     WHERE source = $1 AND status = 'ok' AND rows_found IS NOT NULL AND started_at < $2
     ORDER BY started_at DESC
     LIMIT $3`,
    [source, before, limit]
  );
  return median(rows.map((r) => Number(r.rows_found)));
}

/**
 * Evaluate today's adapter-run summary (as returned by runAdapterGroups)
 * against each source's recent history. Only entries with status 'ok' are
 * evaluated — adapters skipped this run (e.g. --fast mode) or that errored
 * outright are left out, so they're neither penalised nor double-reported.
 *
 * @returns {Promise<Array<{source, found, median, warn}>>}
 */
export async function evaluateVolume(summary, { before = new Date() } = {}) {
  const results = [];
  for (const s of summary) {
    if (s.status !== 'ok') continue;
    const medianVal = await getRecentMedian(s.source, { before });
    results.push({ source: s.source, found: s.found, median: medianVal, warn: isVolumeDrop(s.found, medianVal) });
  }
  return results;
}

/** Render the "Source health" markdown table appended to the daily report. */
export function renderSourceHealthTable(summary, volumeResults) {
  const bySource = new Map(volumeResults.map((r) => [r.source, r]));
  const lines = [
    '## Source health',
    '',
    '| Source | Found today | 14-run median | Status |',
    '|--------|-------------|---------------|--------|',
  ];
  for (const s of summary) {
    const v = bySource.get(s.source);
    const found = s.status === 'ok' ? s.found : '—';
    const med = v?.median != null ? v.median : '—';
    const status = v?.warn ? 'warn' : s.status;
    lines.push(`| ${s.source} | ${found} | ${med} | ${status} |`);
  }
  return lines.join('\n') + '\n';
}
