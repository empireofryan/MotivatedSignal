import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  getDailyReport,
  resolveWindowOption,
  resolveFiledOption,
  type ReportRow,
  type ReportSignal,
} from '../../../../lib/report';
import { getAccessState } from '../../../../lib/access';

// Pro CSV export of the current /report view: GET /api/report/export?window=…&filed=…&homeowners=…&format=…
// Same `ms_pro` cookie gate as the page (set by /api/pro?key=… or /api/trial?k=…); free visitors
// (no cookie, or a cookie that doesn't match PRO_KEY/TRIAL_KEY) get redirected to /pricing instead
// of a CSV. Reuses getDailyReport with the page's own limit (50) so the export matches what a Pro
// visitor already sees on screen, not the free-tier top 10.
//
// `format`:
//   - (absent)/`csv`      — our own column set (below).
//   - `batchleads`        — First Name, Last Name, Property Address/City/State/Zip, Mailing
//                           Address/City/State/Zip, APN, then our extras appended.
//   - `propstream`        — same field order/meaning as batchleads. PropStream's exact
//                           proprietary header text could not be verified against a public
//                           doc via WebFetch (their import template is generated inside the
//                           product, not published) — this reuses the same generic header
//                           names rather than inventing PropStream-specific ones. Documented
//                           in docs/competitors.md's 2026-10-05 shipped section.
export const dynamic = 'force-dynamic';

const REPORT_LIMIT = 50; // keep in sync with web/app/(app)/report/page.tsx's own getDailyReport call

const RECORDER_TYPES = new Set(['trustee_sale', 'lis_pendens', 'mechanics_lien', 'lien']);
const COURT_TYPES = new Set(['probate', 'divorce']);

const CSV_HEADER = [
  'rank', 'score', 'hot', 'address', 'city', 'zip', 'owner', 'absentee', 'mailing_address',
  'signal_types', 'filed', 'est_auction_date', 'days_to_auction', 'assessed_value',
  'last_sale_price', 'years_owned', 'apn',
  // added 2026-10-05 (import-ready export)
  'owner_first', 'owner_last', 'mailing_street', 'mailing_city', 'mailing_state', 'mailing_zip',
  'recorder_doc_number', 'court_case_number', 'source_urls', 'first_seen',
];

// Shared mapped-field order for the vendor list-import formats. "Our extras"
// (appended after the 11 mapped columns) intentionally excludes columns that
// duplicate a mapped field (owner_name, mailing_address, situs city/zip/apn).
const MAPPED_HEADER = [
  'First Name', 'Last Name', 'Property Address', 'Property City', 'Property State', 'Property Zip',
  'Mailing Address', 'Mailing City', 'Mailing State', 'Mailing Zip', 'APN',
];
const MAPPED_EXTRAS_HEADER = [
  'score', 'hot', 'signal_types', 'filed', 'est_auction_date', 'days_to_auction',
  'assessed_value', 'last_sale_price', 'years_owned', 'recorder_doc_number',
  'court_case_number', 'source_urls', 'first_seen',
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// Date-ish values round-trip through `pg` as JS Date objects for DATE/TIMESTAMP columns even
// though ReportRow types them as strings (no custom type parser is registered) — normalize
// through `Date` either way and format as a plain YYYY-MM-DD, UTC, matching the page's own
// UTC-normalized date handling (fmtDate/fmtAuction in page.tsx) so a date never shifts a day.
function isoDate(value: unknown): string {
  if (!value) return '';
  const d = new Date(value as string | number | Date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function daysToAuction(value: unknown): string {
  if (!value) return '';
  const est = new Date(value as string | number | Date);
  if (Number.isNaN(est.getTime())) return '';
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const estUTC = Date.UTC(est.getUTCFullYear(), est.getUTCMonth(), est.getUTCDate());
  return String(Math.round((estUTC - todayUTC) / 86400000));
}

// Assessor owner_name arrives as "LAST FIRST M" or a couple as "LAST FIRST/SPOUSE"
// (middle initial/second person dropped before the slash). Entities and trusts
// (LLC/bank/corp via is_entity, or a bare "TRUST"/"TRUSTEE"/"ESTATE OF" that
// is_entity deliberately leaves as a homeowner) get the full name in owner_last
// with owner_first left blank — there's no "first name" to split out of either.
const TRUST_OR_ESTATE = /\b(TRUST|TRUSTEES?)\b|\bESTATE OF\b/i;
function splitOwnerName(ownerName: string | null, isEntity: boolean): { first: string; last: string } {
  const raw = (ownerName ?? '').trim();
  if (!raw) return { first: '', last: '' };
  if (isEntity || TRUST_OR_ESTATE.test(raw)) return { first: '', last: raw };
  const primary = raw.split('/')[0].trim();
  const toks = primary.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return { first: '', last: raw };
  return { first: toks.length > 1 ? toks[1] : '', last: toks[0] };
}

// mailing_address looks like "4948 E PRINCESS DR, MESA, AZ, 85205". Owner-occupied
// rows (absentee === false) copy the situs address instead of splitting the
// assessor's mailing string — guaranteed to match the property, not just
// "probably the same address in different formatting."
function mailingFieldsFor(r: ReportRow): { street: string; city: string; state: string; zip: string } {
  if (r.absentee === false) {
    return { street: r.situs_address ?? '', city: r.situs_city ?? '', state: 'AZ', zip: r.situs_zip ?? '' };
  }
  const parts = (r.mailing_address ?? '').split(',').map((p) => p.trim());
  const [street = '', city = '', state = '', zip = ''] = parts;
  return { street, city, state, zip };
}

// Newest (signals is already ordered newest-first) external_id among the given
// signal_types, for recorder_doc_number / court_case_number.
function newestExternalId(signals: ReportSignal[] | undefined, types: Set<string>): string {
  const hit = (signals ?? []).find((sig) => types.has(sig.type));
  return hit?.external_id ?? '';
}

function sourceUrlsJoined(signals: ReportSignal[] | undefined): string {
  const urls = [...new Set((signals ?? []).map((sig) => sig.source_url).filter((u): u is string => !!u))];
  return urls.join('|');
}

function rowToCsv(r: ReportRow, rank: number): string {
  const { first, last } = splitOwnerName(r.owner_name, r.is_entity);
  const mailing = mailingFieldsFor(r);
  return [
    rank,
    r.score ?? '',
    r.is_hot ? 'yes' : 'no',
    csvCell(r.situs_address),
    csvCell(r.situs_city),
    csvCell(r.situs_zip),
    csvCell(r.owner_name),
    r.absentee === true ? 'yes' : r.absentee === false ? 'no' : '',
    csvCell(r.mailing_address),
    csvCell(r.signal_types ?? r.signal_type),
    isoDate(r.event_date),
    isoDate(r.est_auction_date),
    daysToAuction(r.est_auction_date),
    r.assessed_value ?? '',
    r.last_sale_price ?? '',
    r.years_owned ?? '',
    csvCell(r.apn),
    csvCell(first),
    csvCell(last),
    csvCell(mailing.street),
    csvCell(mailing.city),
    csvCell(mailing.state),
    csvCell(mailing.zip),
    csvCell(newestExternalId(r.signals, RECORDER_TYPES)),
    csvCell(newestExternalId(r.signals, COURT_TYPES)),
    csvCell(sourceUrlsJoined(r.signals)),
    isoDate(r.first_seen),
  ].join(',');
}

function rowToMappedCsv(r: ReportRow): string {
  const { first, last } = splitOwnerName(r.owner_name, r.is_entity);
  const mailing = mailingFieldsFor(r);
  return [
    csvCell(first),
    csvCell(last),
    csvCell(r.situs_address),
    csvCell(r.situs_city),
    'AZ',
    csvCell(r.situs_zip),
    csvCell(mailing.street),
    csvCell(mailing.city),
    csvCell(mailing.state),
    csvCell(mailing.zip),
    csvCell(r.apn),
    r.score ?? '',
    r.is_hot ? 'yes' : 'no',
    csvCell(r.signal_types ?? r.signal_type),
    isoDate(r.event_date),
    isoDate(r.est_auction_date),
    daysToAuction(r.est_auction_date),
    r.assessed_value ?? '',
    r.last_sale_price ?? '',
    r.years_owned ?? '',
    csvCell(newestExternalId(r.signals, RECORDER_TYPES)),
    csvCell(newestExternalId(r.signals, COURT_TYPES)),
    csvCell(sourceUrlsJoined(r.signals)),
    isoDate(r.first_seen),
  ].join(',');
}

const FORMATS = new Set(['csv', 'batchleads', 'propstream']);

export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const access = await getAccessState({
    proCookie: cookieStore.get('ms_pro')?.value,
    trialCookie: cookieStore.get('ms_trial')?.value,
  });
  if (!access.isPro) {
    return NextResponse.redirect(new URL('/pricing', request.url), 302);
  }

  const { searchParams } = request.nextUrl;
  const win = resolveWindowOption(searchParams.get('window') ?? undefined);
  const filedOpt = resolveFiledOption(searchParams.get('filed') ?? undefined);
  const filedHours = filedOpt.days !== undefined ? filedOpt.days * 24 : undefined;
  const homeownersOnly = searchParams.get('homeowners') !== '0';
  const formatParam = searchParams.get('format') ?? 'csv';
  const format = FORMATS.has(formatParam) ? formatParam : 'csv';

  const { rows } = await getDailyReport(win.hours, REPORT_LIMIT, filedHours, homeownersOnly);

  const lines =
    format === 'csv'
      ? [CSV_HEADER.join(','), ...rows.map((r, i) => rowToCsv(r, i + 1))]
      : [[...MAPPED_HEADER, ...MAPPED_EXTRAS_HEADER].join(','), ...rows.map((r) => rowToMappedCsv(r))];
  const csv = lines.join('\n') + '\n';

  const dateStr = new Date().toISOString().slice(0, 10);
  const suffix = format === 'csv' ? '' : `-${format}`;
  const filename = `motivatedsignal-${dateStr}-${win.key}${suffix}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
