import type { Client } from '@libsql/client';
import { getDailyReport } from './report';
import {
  subjectFor,
  firstName,
  emailBody,
  emailBodyWithLeads,
  classifyInboxEmail,
  ensureLinkCodes,
  getLatestCampaign,
  getLatestMatchDate,
  getMatchesByProspect,
  type ProspectMatchRow,
  type Variant,
} from './outreach';
import { selectBatch, type BatchCandidate } from './outreach-logic';

// Single source of truth for rendering Email A. Used by the /admin send sheet and by
// /api/admin/next-batch (the automated sender), so both always show the same subject + body.

export const SITE = 'https://motivatedsignal.com';

export type ReportNumbers = { n24: number; n7: number; s: number; nt: number; ok: boolean };

export async function getReportNumbers(): Promise<ReportNumbers> {
  try {
    const [day, week] = await Promise.all([
      getDailyReport(24, 5000, undefined, true),
      // 7-day window with the report page's default 14-day filed filter (its
      // 7-day chip default) — this is N7 for Email A pass 3, so it must match
      // what a prospect would see if they clicked through.
      getDailyReport(24 * 7, 5000, 24 * 14, true),
    ]);
    // Homeowner report rows (deduped per parcel), matching the /report page.
    // Note: pg returns count() as strings, so never sum `counts[].n` without Number().
    const n24 = day.rows.length;
    const n7 = week.rows.length;
    const s7 = week.rows.filter((r) => (r.stacked_types ?? 0) >= 2).length;
    // NT: this week's trustee-sale rows where the owner has 10+ years in the house — the Email A
    // lender-opening count (docs/outreach-plan.md). `signal_types` is a comma-joined string.
    const nt7 = week.rows.filter((r) => {
      const types = String(r.signal_types ?? '').split(',');
      return types.includes('trustee_sale') && Number(r.years_owned ?? 0) >= 10;
    }).length;
    return { n24, n7, s: s7, nt: nt7, ok: true };
  } catch (err) {
    console.error('getReportNumbers failed', err);
    return { n24: 0, n7: 0, s: 0, nt: 0, ok: false };
  }
}

/** Touch 1 carries the prospect's 2 matched leads when they exist for the latest match_date;
 * otherwise fall back to the no-leads body (docs/outreach-plan.md Email A). */
export function renderEmailBody(ctx: {
  first: string;
  segment: string | null;
  link: string;
  matches: ProspectMatchRow[];
  reportNumbers: ReportNumbers;
}): string {
  const { first, segment, link, matches, reportNumbers } = ctx;
  return matches.length >= 2
    ? emailBodyWithLeads({
        first,
        n7: reportNumbers.n7,
        s: reportNumbers.s,
        nt: reportNumbers.nt,
        segment,
        matches: matches.slice(0, 2).map((m) => ({ pitchLine: m.pitchLine, matchTier: m.matchTier })),
        link,
      })
    : emailBody({ first, n7: reportNumbers.n7, s: reportNumbers.s, segment, link });
}

export type NextBatchItem = {
  prospect_id: number;
  campaign_id: number;
  variant: Variant;
  to: string;
  to_name: string | null;
  subject: string;
  body: string;
};

export async function getNextBatch(db: Client, n: number): Promise<NextBatchItem[]> {
  const campaign = await getLatestCampaign(db);
  await ensureLinkCodes(db);
  const [prospects, sentRows, latestMatchDate, reportNumbers] = await Promise.all([
    db.execute(
      `SELECT id, rank, company, contact_name, segment, email, url, status, subject_variant, link_code
       FROM prospects WHERE status = 'new' AND email IS NOT NULL AND email <> ''`
    ),
    db.execute({
      sql: `SELECT DISTINCT prospect_id FROM outreach_events WHERE campaign_id = ? AND event = 'sent'`,
      args: [campaign.id],
    }),
    getLatestMatchDate(db),
    getReportNumbers(),
  ]);
  // Never email with numbers we could not compute (the subject/body would say "0 filings").
  if (!reportNumbers.ok) throw new Error('report numbers unavailable');

  const sent = new Set(sentRows.rows.map((r) => Number(r.prospect_id)));
  const matchesByProspect = latestMatchDate ? await getMatchesByProspect(db, latestMatchDate) : new Map<number, ProspectMatchRow[]>();

  const candidates: BatchCandidate[] = prospects.rows.map((p) => {
    const id = Number(p.id);
    return {
      id,
      rank: Number(p.rank),
      segment: (p.segment as string | null) ?? null,
      email: (p.email as string | null) ?? null,
      status: String(p.status ?? 'new'),
      variant: (p.subject_variant as string | null) ?? null,
      inboxFlag: classifyInboxEmail(p.email as string | null, p.url as string | null),
      matchTiers: (matchesByProspect.get(id) ?? []).map((m) => m.matchTier),
      alreadySent: sent.has(id),
    };
  });

  const byId = new Map(prospects.rows.map((p) => [Number(p.id), p]));
  return selectBatch(candidates, n)
    .filter((c) => String(byId.get(c.id)?.link_code ?? '') !== '')
    .map((c) => {
      const p = byId.get(c.id)!;
      const company = String(p.company ?? '');
      const variant = c.variant as Variant;
      const body = renderEmailBody({
        first: firstName(p.contact_name as string | null),
        segment: c.segment,
        link: `${SITE}/r/${String(p.link_code)}`,
        matches: matchesByProspect.get(c.id) ?? [],
        reportNumbers,
      });
      return {
        prospect_id: c.id,
        campaign_id: campaign.id,
        variant,
        to: String(c.email),
        to_name: (p.contact_name as string | null) ?? null,
        subject: subjectFor(variant, { n7: reportNumbers.n7, company }),
        body,
      };
    });
}
