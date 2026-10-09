/**
 * Backstop skip-check for daily.js --if-not-ran-today.
 *
 * The 08:23 Phoenix backstop cron exists because the 06:23 primary can be
 * delayed/dropped by GitHub (see .github/workflows/daily.yml). Before the
 * backstop does any real work, it checks whether recorder_nots already
 * completed (ok/warn) earlier today, Phoenix time, and exits immediately if
 * so — so a healthy primary run doesn't get duplicated by the backstop.
 *
 * America/Phoenix does not observe DST, so it's a fixed UTC-7 offset
 * year-round — no Intl timezone math needed beyond computing "today" there.
 */

export function phoenixDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(date);
}

/** UTC [start, end) bounds of "today" in Phoenix, for `date`. */
export function phoenixDayBoundsUtc(date = new Date()) {
  const dateStr = phoenixDateString(date);
  const start = new Date(`${dateStr}T00:00:00-07:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * Returns the most recent scrape_runs row for `source` that started today
 * (Phoenix time) with status ok/warn, or null if none ran yet today.
 *
 * `queryFn` is injected (normally src/db.js's `query`) so this is unit
 * testable without a DB. Callers should treat a rejected promise (DB
 * unreachable) as "fall through to a normal run", not as "didn't run".
 */
export async function findTodaysRun(queryFn, { source = 'recorder_nots', now = new Date() } = {}) {
  const { start, end } = phoenixDayBoundsUtc(now);
  const { rows } = await queryFn(
    `SELECT started_at FROM scrape_runs
     WHERE source = $1 AND status IN ('ok','warn') AND started_at >= $2 AND started_at < $3
     ORDER BY started_at DESC LIMIT 1`,
    [source, start, end]
  );
  return rows[0] ?? null;
}
