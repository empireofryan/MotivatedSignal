/**
 * Fetch a Maricopa Superior Court docket page with throttle awareness.
 * The court answers "Server busy. Please try again later." (36 bytes) when it
 * rate-limits an IP — that is NOT a missing case. Back off and retry; if it
 * stays busy, report 'busy' so the walker stops without burning miss budget
 * or advancing resume state.
 *   → { status: 'ok' | 'miss' | 'busy', text }
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BUSY_RE = /Server busy/i;
const BACKOFFS_MS = [30_000, 60_000, 120_000];

/**
 * Pure streak bookkeeping shared by court_probate.js and court_divorce.js, so
 * both walkers agree on how 'busy' vs 'miss' are tolerated.
 *
 *   - 'busy' means the court's backend is overloaded/down, NOT that the case
 *     is absent. It must never count toward missStop (mixing the two would
 *     make a transient outage look like "ran off the end of real cases" and
 *     stop the walk short of live numbers) and the caller must never advance
 *     its resume high-water mark for a busy case — it has to be re-tried.
 *     But unbounded 'busy' tolerance would hang a run during a genuine
 *     multi-hour outage, so busy gets its own cap (maxBusyStreak). Each
 *     'busy' already cost up to ~210s inside fetchCase's own backoff, so a
 *     handful of consecutive busy signals is a meaningful wait before giving
 *     up — see court_probate.js/court_divorce.js for the chosen default.
 *   - Any non-busy response (ok or miss) clears the busy streak, since the
 *     backend evidently answered that request.
 *   - 'ok' clears both streaks (a live case proves the walk is still in
 *     live territory).
 *
 * @returns {{busyStreak: number, misses: number, stop: boolean}}
 */
export function advanceWalk(status, { busyStreak, misses }, { maxBusyStreak, missStop }) {
  if (status === 'busy') {
    const nextBusyStreak = busyStreak + 1;
    return { busyStreak: nextBusyStreak, misses, stop: nextBusyStreak >= maxBusyStreak };
  }
  if (status === 'miss') {
    const nextMisses = misses + 1;
    return { busyStreak: 0, misses: nextMisses, stop: nextMisses >= missStop };
  }
  return { busyStreak: 0, misses: 0, stop: false };
}

export async function fetchCase(url, { throttleMs = 1500 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res, text;
    try {
      res = await globalThis.fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      text = await res.text();
    } catch {
      await new Promise((r) => setTimeout(r, throttleMs));
      return { status: 'miss', text: '' };
    }
    await new Promise((r) => setTimeout(r, throttleMs));

    if (BUSY_RE.test(text) && text.length < 200) {
      if (attempt >= BACKOFFS_MS.length) return { status: 'busy', text };
      const wait = BACKOFFS_MS[attempt];
      console.warn(`[court] server busy — backing off ${wait / 1000}s (attempt ${attempt + 1}/${BACKOFFS_MS.length})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    // Non-existent cases return the nav shell without case content.
    if (!res.ok || text.length < 500 || !text.includes('Case Number:')) return { status: 'miss', text };
    return { status: 'ok', text };
  }
}
