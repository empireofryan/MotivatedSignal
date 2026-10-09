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
