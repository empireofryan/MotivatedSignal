// Shared display-layer helpers for the Daily Report table and its row-expand
// panel. Pure functions only (no 'use client' needed) so both the server
// page.tsx and the client RowExpand.tsx component import one copy instead of
// drifting apart.

export const SIGNAL_LABELS: Record<string, string> = {
  trustee_sale: 'Trustee sale',
  probate: 'Probate',
  divorce: 'Divorce',
  code_violation: 'Code violation',
  lis_pendens: 'Lis pendens',
  mechanics_lien: 'Mechanic’s lien',
  lien: 'Lien',
  tax_delinquent: 'Tax delinquent',
};

// Signals that put a deadline on the owner — drawn stronger in the row.
export const PLURALS: Record<string, string> = {
  trustee_sale: 'trustee sales', probate: 'probate filings', divorce: 'divorce filings',
  code_violation: 'code violations', lis_pendens: 'lis pendens', mechanics_lien: 'mechanic’s liens',
  lien: 'liens', tax_delinquent: 'tax delinquencies',
};

export const URGENT = new Set(['trustee_sale', 'lis_pendens', 'probate', 'divorce']);

// Provenance verb per signal_type for the row-expand panel: county recorder
// documents are "Recorded", court cases are "Filed"/"Opened", city case
// systems "Filed". Default to "Recorded" (covers tax_delinquent and any
// future recorder-sourced type).
const PROVENANCE_VERB: Record<string, string> = {
  probate: 'Opened',
  divorce: 'Filed',
  code_violation: 'Filed',
};
export function provenanceVerb(signalType: string): string {
  return PROVENANCE_VERB[signalType] ?? 'Recorded';
}

export function fmtMoney(n: number) {
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}m` : `$${Math.round(n / 1000)}k`;
}

const KEEP_UPPER = new Set(['LLC', 'LP', 'LLP', 'INC', 'II', 'III', 'IV', 'TR', 'PO', 'AZ', 'NA']);
export function titleCase(raw: string) {
  return raw
    .toLowerCase()
    .split(/(\s+|\/|&)/)
    .map((tok) => {
      const up = tok.toUpperCase();
      if (KEEP_UPPER.has(up.replace(/[^A-Z]/g, ''))) return up;
      return tok.replace(/^([a-z])|([-'][a-z])/g, (m) => m.toUpperCase());
    })
    .join('');
}

// Display-layer fix for a since-fixed ingest bug: situs_address was sometimes
// built by appending the unit twice from two source columns ("... AVE 2026
// 2026"). Collapses an immediately-repeated trailing token, then — since the
// assessor's own export puts a bare unit number right after the street-type
// word with no "#" — reformats that trailing unit as "#NNNN" so existing rows
// render correctly without a re-ingest. A street-type word must be present;
// an address with no suffix (e.g. a rural route) is left as-is.
const STREET_TYPE_WORDS = new Set([
  'AVE', 'AV', 'ST', 'DR', 'RD', 'LN', 'CT', 'PL', 'WAY', 'WY', 'CIR',
  'BLVD', 'PKWY', 'TRL', 'TER', 'HWY',
]);
export function formatSitusAddress(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  while (tokens.length >= 2 && tokens[tokens.length - 1].toUpperCase() === tokens[tokens.length - 2].toUpperCase()) {
    tokens.pop();
  }
  let typeIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (STREET_TYPE_WORDS.has(tokens[i].toUpperCase())) typeIdx = i;
  }
  if (typeIdx === -1 || typeIdx === tokens.length - 1) return tokens.join(' ');
  const base = tokens.slice(0, typeIdx + 1).join(' ');
  const unit = tokens.slice(typeIdx + 1).join(' ');
  return `${base} #${unit}`;
}

export function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// First-seen timestamps are real TIMESTAMPTZ instants (unlike the UTC-midnight
// DATE values fmtDate handles), so format in the actual America/Phoenix wall
// clock rather than UTC. Phoenix has no DST, so this is always fixed UTC-7.
export function fmtDatePhoenix(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Phoenix' });
}

export function fmtDateTimePhoenix(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' }) +
    ', ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' }) +
    ' Phoenix'
  );
}

// Auction column: the county recorder doesn't publish the trustee-sale date, so
// est_auction_date (computed in SQL as newest trustee_sale event_date + 90d, the
// A.R.S. 33-808 minimum notice period) is always an estimate. Day-level diff vs.
// today, UTC-normalized to match fmtDate's convention.
export function fmtAuction(iso: string) {
  const est = new Date(iso);
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const estUTC = Date.UTC(est.getUTCFullYear(), est.getUTCMonth(), est.getUTCDate());
  const diffDays = Math.round((estUTC - todayUTC) / 86400000);
  const rel =
    diffDays === 0
      ? 'today'
      : diffDays > 0
        ? `in ${diffDays} day${diffDays === 1 ? '' : 's'}`
        : `passed ${Math.abs(diffDays)}d ago`;
  return { dateStr: fmtDate(iso), rel };
}

// Free-visitor privacy mask for probate/divorce rows: these are public-record
// case types, but naming a specific person next to "divorce" on an open page
// is a bad look. Reduces "SMITH JOHN A" (or "John Smith") to "S. J. A." — same
// treatment regardless of assessor "LAST FIRST M" ordering vs. a plain name,
// since we only need to avoid spelling out the full name, not reorder it.
// Space-separated (not "S.J.A.") so titleCase — which only re-capitalizes
// after whitespace/hyphen/apostrophe, never after a bare period — renders
// every initial correctly instead of lowercasing all but the first.
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return name;
  return words.map((w) => `${w[0].toUpperCase()}.`).join(' ');
}

// Whole days remaining until an ISO instant, clamped at 0. Used for the trial
// pill ("Trial: N days left"). A plain helper (not inlined in the page
// component) so the component body itself stays free of a direct Date.now()
// call, per this Next.js version's react-hooks purity rule.
export function daysLeftUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

export function listSentence(parts: string[]) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
