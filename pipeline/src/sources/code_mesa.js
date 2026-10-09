// pipeline/src/sources/code_mesa.js
// Mesa AZ code compliance cases via Socrata (data.mesaaz.gov)
// Real fields from fixture: record_id, permit_number, opened_date, status, case_address, parcel_number
import { normalizeApn } from '../normalize.js';
import { withRetry, HttpError } from '../retry.js';

const BASE = 'https://data.mesaaz.gov/resource/hgf6-yenu.json';

// Single page fetch wrapped in retry-with-backoff — see retry.js for why
// (bulk pages here measure ~1-1.2s; failures are sleep/network blips, not a
// slow server, and $offset makes a retried page cheap and safe).
async function fetchPage(url, { retries, baseDelayMs, maxDelayMs }) {
  return withRetry(
    async () => {
      const res = await fetch(url);
      if (!res.ok) throw new HttpError(`Mesa HTTP ${res.status}`, res.status);
      return res.json();
    },
    {
      retries,
      baseDelayMs,
      maxDelayMs,
      onRetry: ({ attempt, retries: max, delay, error }) =>
        console.log(`[code_mesa] retry ${attempt}/${max} in ${(delay / 1000).toFixed(1)}s (${error.message})`),
    }
  );
}

export function mapMesa(rows) {
  return rows.map((r) => ({
    apn: r.parcel_number ? normalizeApn(r.parcel_number) : null,
    externalId: String(r.permit_number ?? r.record_id ?? r[':id']),
    sourceUrl: 'https://data.mesaaz.gov/resource/hgf6-yenu',
    eventDate: r.opened_date ? r.opened_date.slice(0, 10) : null,
    status: r.status ?? null,
    situsAddress: r.case_address ?? null,
    raw: r,
  })).filter((r) => r.externalId && r.externalId !== 'undefined');
}

export default {
  id: 'code_mesa',
  signalType: 'code_violation',
  kind: 'api',
  async fetch() {
    const out = [];
    let offset = 0;
    const LIMIT = 1000;
    for (;;) {
      const rows = await fetchPage(`${BASE}?$limit=${LIMIT}&$offset=${offset}&$order=:id`, {
        retries: 6, baseDelayMs: 5_000, maxDelayMs: 90_000,
      });
      out.push(...rows);
      if (rows.length < LIMIT) break;
      offset += LIMIT;
      await new Promise((r) => setTimeout(r, 300));
    }
    return mapMesa(out);
  },
};
