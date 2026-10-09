// pipeline/src/arcgis.js
import { withRetry, HttpError } from './retry.js';

// A single page fetch wrapped in retry-with-backoff. Pagination is driven by
// offset, so retrying a failed page is safe and cheap — see retry.js for why
// this (not a bigger timeout) is the right fix for the sleep-induced aborts.
async function fetchPage(u, { retries, baseDelayMs, maxDelayMs }) {
  return withRetry(
    async () => {
      const res = await fetch(u);
      if (!res.ok) throw new HttpError(`ArcGIS ${res.status} ${u}`, res.status);
      return res.json();
    },
    {
      retries,
      baseDelayMs,
      maxDelayMs,
      onRetry: ({ attempt, retries: max, delay, error }) =>
        console.log(`[arcgis] retry ${attempt}/${max} in ${(delay / 1000).toFixed(1)}s (${error.message}): ${u}`),
    }
  );
}

export async function fetchArcgisAll(serviceUrl, {
  where = '1=1', outFields = '*', pageSize = 2000,
  retries = 6, baseDelayMs = 5_000, maxDelayMs = 90_000,
} = {}) {
  const features = [];
  let offset = 0;
  // Some servers (e.g. Scottsdale MapServer tables) don't have a field named OBJECTID
  // and reject orderByFields=OBJECTID with a 400 error. We try with ORDER BY first and
  // fall back to no ordering if the first request returns a JSON error.
  let useOrderBy = true;

  for (;;) {
    const orderPart = useOrderBy ? '&orderByFields=OBJECTID' : '';
    const u = `${serviceUrl}/query?where=${encodeURIComponent(where)}&outFields=${encodeURIComponent(outFields)}`
            + `${orderPart}&resultOffset=${offset}&resultRecordCount=${pageSize}&f=json`;
    const json = await fetchPage(u, { retries, baseDelayMs, maxDelayMs });
    if (json.error) {
      // If ordering failed, retry this page without orderByFields (once only)
      if (useOrderBy) {
        useOrderBy = false;
        continue;
      }
      throw new Error(`ArcGIS error ${serviceUrl}: ${JSON.stringify(json.error)}`);
    }
    const batch = json.features ?? [];
    features.push(...batch);
    // Continuation is driven by the server's exceededTransferLimit flag.
    // Offset advances by actual features returned (not pageSize), so servers that
    // cap their maxRecordCount below pageSize still paginate correctly.
    if (batch.length === 0 || json.exceededTransferLimit !== true) break;
    offset = features.length;
    await new Promise(r => setTimeout(r, 200)); // polite delay between pages
  }
  return features;
}
