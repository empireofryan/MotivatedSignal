import type { Client } from '@libsql/client';
import crypto from 'node:crypto';

// Shared schema + helpers for the cold-email campaign dashboard (subject A/B/C/D test,
// open/click/reply tracking, send-sheet email generation). Turso-backed, alongside
// access_requests / prospects / trial_clicks / page_events.

export type Variant = 'A' | 'B' | 'C' | 'D';
export const VARIANTS: Variant[] = ['A', 'B', 'C', 'D'];

export type OutreachEvent =
  | 'sent'
  | 'opened'
  | 'clicked'
  | 'replied'
  | 'trial'
  | 'paid'
  | 'stop'
  | 'bounced';

export const ADMIN_EVENTS: OutreachEvent[] = ['sent', 'replied', 'stop', 'bounced', 'paid'];

let schemaReady: Promise<void> | null = null;

/** Idempotent. Creates campaigns + outreach_events, adds prospects.subject_variant if missing. */
export function ensureOutreachSchema(db: Client): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS campaigns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          touch INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS outreach_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prospect_id INTEGER,
          campaign_id INTEGER,
          variant TEXT,
          event TEXT NOT NULL,
          meta TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_outreach_events_prospect ON outreach_events(prospect_id, campaign_id, event)`
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_outreach_events_campaign ON outreach_events(campaign_id, event, variant)`
      );

      const cols = await db.execute('PRAGMA table_info(prospects)');
      const hasVariant = cols.rows.some((c) => c.name === 'subject_variant');
      if (!hasVariant) {
        await db.execute('ALTER TABLE prospects ADD COLUMN subject_variant TEXT');
      }
      const hasLinkCode = cols.rows.some((c) => c.name === 'link_code');
      if (!hasLinkCode) {
        await db.execute('ALTER TABLE prospects ADD COLUMN link_code TEXT');
      }
      await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_prospects_link_code ON prospects(link_code)');

      // First-party page analytics (pageview/engaged_time/scroll_depth/custom events). vid =
      // anonymous per-visitor id (cookie `ms_vid`); prospect_id is filled only when the visitor
      // carries a verified `ms_pid` cookie (set by /r/<code>, see signProspectId/verifyProspectId
      // below). meta is a JSON string; ms is used by the `engaged_time` event.
      await db.execute(`
        CREATE TABLE IF NOT EXISTS page_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vid TEXT,
          prospect_id INTEGER,
          session_id TEXT,
          path TEXT,
          event TEXT NOT NULL,
          meta TEXT,
          ms INTEGER,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      await db.execute('CREATE INDEX IF NOT EXISTS idx_page_events_prospect ON page_events(prospect_id, created_at)');
      await db.execute('CREATE INDEX IF NOT EXISTS idx_page_events_vid ON page_events(vid, created_at)');

      const count = await db.execute('SELECT count(*) AS n FROM campaigns');
      if (Number(count.rows[0]?.n ?? 0) === 0) {
        await db.execute({
          sql: 'INSERT INTO campaigns (name, touch) VALUES (?, ?)',
          args: ['Touch 1 · Oct 2026', 1],
        });
      }
    })();
  }
  return schemaReady;
}

export type Campaign = { id: number; name: string; touch: number; created_at: string };

export async function listCampaigns(db: Client): Promise<Campaign[]> {
  const res = await db.execute('SELECT id, name, touch, created_at FROM campaigns ORDER BY id DESC');
  return res.rows as unknown as Campaign[];
}

export async function getLatestCampaign(db: Client): Promise<Campaign> {
  await ensureOutreachSchema(db);
  const res = await db.execute('SELECT id, name, touch, created_at FROM campaigns ORDER BY id DESC LIMIT 1');
  return res.rows[0] as unknown as Campaign;
}

/** Fills subject_variant for prospects where it's null, round-robin A/B/C/D within each segment
 * ordered by rank, continuing the sequence from however many are already assigned in that segment
 * so repeated runs (e.g. after adding new prospects) stay balanced. Returns rows updated. */
export async function assignMissingVariants(db: Client): Promise<number> {
  await ensureOutreachSchema(db);
  const segments = await db.execute('SELECT DISTINCT segment FROM prospects');
  let updated = 0;
  const stmts: Array<{ sql: string; args: (string | number)[] }> = [];

  for (const segRow of segments.rows) {
    const segment = (segRow.segment as string | null) ?? null;
    const existing = await db.execute({
      sql: 'SELECT count(*) AS n FROM prospects WHERE segment IS ? AND subject_variant IS NOT NULL',
      args: [segment],
    });
    const startIndex = Number(existing.rows[0]?.n ?? 0);
    const nulls = await db.execute({
      sql: 'SELECT id FROM prospects WHERE segment IS ? AND subject_variant IS NULL ORDER BY rank ASC',
      args: [segment],
    });
    nulls.rows.forEach((row, i) => {
      const variant = VARIANTS[(startIndex + i) % VARIANTS.length];
      stmts.push({
        sql: 'UPDATE prospects SET subject_variant = ? WHERE id = ?',
        args: [variant, Number(row.id)],
      });
    });
  }

  if (stmts.length > 0) {
    await db.batch(stmts, 'write');
    updated = stmts.length;
  }
  return updated;
}

// ---- Tracked links (/r/<code>) — one stable code per prospect ----

const LINK_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomLinkCode(): string {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += LINK_CODE_ALPHABET[bytes[i] % LINK_CODE_ALPHABET.length];
  return out;
}

/** Generates a stable 8-char base62 `link_code` for every prospect that doesn't have one yet.
 * Idempotent, safe to re-run. Returns the number of prospects updated. */
export async function ensureLinkCodes(db: Client): Promise<number> {
  await ensureOutreachSchema(db);
  const existing = await db.execute('SELECT link_code FROM prospects WHERE link_code IS NOT NULL');
  const used = new Set(existing.rows.map((r) => String(r.link_code)));
  const missing = await db.execute('SELECT id FROM prospects WHERE link_code IS NULL');
  if (missing.rows.length === 0) return 0;

  const stmts: Array<{ sql: string; args: (string | number)[] }> = [];
  for (const row of missing.rows) {
    let code = randomLinkCode();
    while (used.has(code)) code = randomLinkCode();
    used.add(code);
    stmts.push({ sql: 'UPDATE prospects SET link_code = ? WHERE id = ?', args: [code, Number(row.id)] });
  }
  await db.batch(stmts, 'write');
  return stmts.length;
}

export type LinkedProspect = {
  id: number;
  segment: string | null;
  status: string;
  variant: string | null;
};

/** Resolves a `/r/<code>` code to the prospect it belongs to, or null if unknown. */
export async function getProspectByLinkCode(db: Client, code: string): Promise<LinkedProspect | null> {
  const res = await db.execute({
    sql: 'SELECT id, segment, status, subject_variant FROM prospects WHERE link_code = ?',
    args: [code],
  });
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: Number(r.id),
    segment: (r.segment as string | null) ?? null,
    status: String(r.status ?? 'new'),
    variant: (r.subject_variant as string | null) ?? null,
  };
}

// ---- Visitor identity: signed `ms_pid` cookie ----
//
// `ms_pid` = `<prospectId>.<hmacHex>`, HMAC-SHA256 over the prospect id using TRACK_SECRET
// (falls back to ADMIN_KEY if TRACK_SECRET isn't set, so this never throws if the env var is
// missing in a preview deploy). Lets /api/track attribute page_events to a prospect without
// ever trusting a client-supplied id.

function trackSecret(): string {
  return process.env.TRACK_SECRET || process.env.ADMIN_KEY || 'motivatedsignal-track-fallback';
}

export function signProspectId(prospectId: number): string {
  const mac = crypto.createHmac('sha256', trackSecret()).update(String(prospectId)).digest('hex').slice(0, 32);
  return `${prospectId}.${mac}`;
}

/** Verifies a signed `ms_pid` cookie value and returns the prospect id, or null if missing/invalid. */
export function verifyProspectId(cookieValue: string | null | undefined): number | null {
  if (!cookieValue) return null;
  const dot = cookieValue.indexOf('.');
  if (dot === -1) return null;
  const idPart = cookieValue.slice(0, dot);
  const macPart = cookieValue.slice(dot + 1);
  if (!/^\d+$/.test(idPart)) return null;
  const expected = signProspectId(Number(idPart)).slice(idPart.length + 1);
  const a = Buffer.from(macPart, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length === 0 || a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return Number(idPart);
}

/** At most one 'opened' event per prospect per campaign per rolling hour. */
export async function logOpen(db: Client, prospectId: number, campaignId: number, variant: string | null) {
  await ensureOutreachSchema(db);
  const dupe = await db.execute({
    sql: `SELECT id FROM outreach_events
          WHERE prospect_id = ? AND campaign_id = ? AND event = 'opened'
            AND created_at > datetime('now', '-1 hour')
          LIMIT 1`,
    args: [prospectId, campaignId],
  });
  if (dupe.rows.length > 0) return;
  await db.execute({
    sql: 'INSERT INTO outreach_events (prospect_id, campaign_id, variant, event) VALUES (?, ?, ?, ?)',
    args: [prospectId, campaignId, variant, 'opened'],
  });
}

export async function logEvent(
  db: Client,
  opts: { prospectId: number | null; campaignId: number | null; variant?: string | null; event: OutreachEvent; meta?: string | null }
) {
  await ensureOutreachSchema(db);
  await db.execute({
    sql: 'INSERT INTO outreach_events (prospect_id, campaign_id, variant, event, meta) VALUES (?, ?, ?, ?, ?)',
    args: [opts.prospectId, opts.campaignId, opts.variant ?? null, opts.event, opts.meta ?? null],
  });
}

// ---- Subject lines + email body (Email A, pass 3 — docs/outreach-plan.md) ----

// Legal-entity suffixes stripped off the end of a company name before building the short form
// used in subject variant C. Checked case-insensitively, with or without a trailing period.
const COMPANY_SUFFIX_RE = /[,\s]+(LLC|L\.L\.C\.|Inc|Incorporated|Corp|Corporation|Co|Company|Group)\.?$/i;

/** First segment of a company name before any " – "/" - "/" ("/"," separator, with a trailing
 * legal-entity suffix (LLC/Inc/Corp/Co/Group) stripped. E.g. "Great Flips – Phoenix Wholesale
 * Houses" -> "Great Flips"; "A & A Funding Corp" -> "A & A Funding". */
export function shortCompanyName(company: string | null | undefined): string {
  if (!company) return '';
  const raw = String(company);
  const cut = raw.match(/ – | - | \(|,/);
  let name = (cut ? raw.slice(0, cut.index) : raw).trim();
  name = name.replace(COMPANY_SUFFIX_RE, '').trim();
  return name;
}

/** Subject variant C: "<ShortName>'s next maricopa seller?", falling back to the name-free
 * "your next maricopa seller?" when the short name is unusable — either still too long (> 28
 * chars, reads as a run-on subject) or ends in "s" (an awkward double-s possessive, e.g.
 * "Great Flips's"). */
export function subjectVariantC(company: string | null | undefined): string {
  const short = shortCompanyName(company);
  if (!short || short.length > 28 || /s$/i.test(short)) {
    return 'your next maricopa seller?';
  }
  return `${short}'s next maricopa seller?`;
}

export function subjectFor(variant: Variant, ctx: { n7: number; company: string }): string {
  switch (variant) {
    case 'A':
      return 'who filed in maricopa this morning?';
    case 'B':
      return `${ctx.n7} maricopa filings this week`;
    case 'C':
      return subjectVariantC(ctx.company);
    case 'D':
      return 'before it hits propstream';
  }
}

export function firstName(contactName: string | null | undefined): string {
  const token = (contactName ?? '').trim().split(/\s+/)[0];
  return token || 'there';
}

/** Tracked-link CTA (2026-10-05): replaces the old "reply send it" ask with a direct link to
 * /r/<code>, which resolves to the prospect + logs a `clicked` event, then grants the same 7-day
 * trial as /api/trial and lands on /report. The TRIAL_KEY itself never appears in an email. */
function closing(link: string): string {
  return `Here's this week's full report, free for 7 days, no card:
${link}

Or reply "send it" and I'll set it up.

Ryan
MotivatedSignal · 1209 Mountain Rd Pl NE Ste R, Albuquerque, NM 87110
Reply "stop" and I won't write again.`;
}

export function emailBody(ctx: { first: string; n7: number; s: number; segment: string | null; link: string }): string {
  const buyOrLend = ctx.segment === 'lender' ? 'lend' : 'buy';
  return `Hi ${ctx.first},

${ctx.n7} Maricopa homeowners picked up a new distress filing this week: trustee-sale notices, probate and divorce cases, code violations, tax delinquency. ${ctx.s} of them have two or more stacked on the same house.

I built a report that pulls those from the county every morning, matches each one to the parcel and the owner's mailing address, and ranks the stacked ones first. You ${buyOrLend} in Maricopa, so you'd see them before they're listed.

${closing(ctx.link)}`;
}

// ---- Email A with matched leads baked into touch 1 (2026-10-04) ----
// Per-prospect matches now live in Turso `prospect_matches` (pipeline/src/match-leads.js writes
// them). When a prospect has 2 matches for the latest match_date, the two leads move from touch 3
// (Email B) into touch 1 so the first email a prospect ever gets already proves the product.
// Lenders get their own opening (trustee-sale + tenure framed as refi/cash-deal flow) instead of
// "near where you buy" — buyers/wholesalers/flippers aren't lending, so that line doesn't land.

export type MatchLine = { pitchLine: string; matchTier: string | null };

const MIDDLE_PARAGRAPH = (n7: number, s: number) => `I pull these from the county every morning: trustee-sale notices, probate and divorce cases, code violations, tax delinquency. Each one is matched to the parcel and the owner's mailing address, and the ones with two or more stacked rise to the top. ${n7} homeowners this week, ${s} of them stacked.`;

/** Email A touch 1, with the two matched leads baked in. Requires exactly 2 `matches` — callers
 * should fall back to `emailBody()` when a prospect has fewer than 2 matches for the latest date. */
export function emailBodyWithLeads(ctx: {
  first: string;
  n7: number;
  s: number;
  nt: number;
  segment: string | null;
  matches: MatchLine[];
  link: string;
}): string {
  const leadsBlock = ctx.matches
    .slice(0, 2)
    .map((m, i) => `${i + 1}. ${m.pitchLine}`)
    .join('\n');
  const middle = MIDDLE_PARAGRAPH(ctx.n7, ctx.s);

  if (ctx.segment === 'lender') {
    const intro =
      ctx.nt > 0
        ? `${ctx.nt} Maricopa homeowners got a trustee-sale notice this week after 10+ years in the house, so most of them have real equity. Those become a bailout refi for you, or a cash deal for an investor you already fund. Either way you want them the day they file, not when PropStream catches up.`
        : `${ctx.nt} Maricopa homeowners got a trustee-sale notice this week. Those become a bailout refi for you, or a cash deal for an investor you already fund. Either way you want them the day they file, not when PropStream catches up.`;

    return `Hi ${ctx.first},

${intro}

${middle}

Two from this week:
${leadsBlock}

${closing(ctx.link)}`;
  }

  // "near where you buy" only lands when at least one of the two matched leads is actually a
  // zip/city match for this prospect — most prospects have no zips/cities on file yet, so their
  // matches are tier 'any' and the geographic claim would be false.
  const nearYou = ctx.matches.some((m) => m.matchTier === 'zip' || m.matchTier === 'city');
  const headline = nearYou
    ? 'Two Maricopa homeowners who filed this week, near where you buy:'
    : 'Two Maricopa homeowners who filed this week:';

  return `Hi ${ctx.first},

${headline}

${leadsBlock}

${middle}

${closing(ctx.link)}`;
}

export type ProspectMatchRow = {
  prospectId: number;
  rank: number;
  pitchLine: string;
  matchTier: string | null;
};

/** The most recent match_date in `prospect_matches`, or null if the table is empty/missing
 * (e.g. before match-leads.js has ever run). Never throws — a missing table just means every
 * prospect falls back to `emailBody()`. */
export async function getLatestMatchDate(db: Client): Promise<string | null> {
  try {
    const res = await db.execute('SELECT match_date FROM prospect_matches ORDER BY match_date DESC LIMIT 1');
    return (res.rows[0]?.match_date as string | undefined) ?? null;
  } catch (err) {
    console.error('getLatestMatchDate failed', err);
    return null;
  }
}

/** All prospect_matches rows for `matchDate`, grouped by prospect_id and sorted by rank. */
export async function getMatchesByProspect(db: Client, matchDate: string): Promise<Map<number, ProspectMatchRow[]>> {
  const map = new Map<number, ProspectMatchRow[]>();
  try {
    const res = await db.execute({
      sql: 'SELECT prospect_id, rank, pitch_line, match_tier FROM prospect_matches WHERE match_date = ? ORDER BY prospect_id ASC, rank ASC',
      args: [matchDate],
    });
    for (const r of res.rows) {
      const prospectId = Number(r.prospect_id);
      const row: ProspectMatchRow = {
        prospectId,
        rank: Number(r.rank),
        pitchLine: String(r.pitch_line ?? ''),
        matchTier: (r.match_tier as string | null) ?? null,
      };
      const existing = map.get(prospectId);
      if (existing) existing.push(row);
      else map.set(prospectId, [row]);
    }
  } catch (err) {
    console.error('getMatchesByProspect failed', err);
  }
  return map;
}

/** Manual reply snippet for when a prospect replies "send it" directly instead of clicking the
 * touch-1 link. Uses the same /r/<code> tracked link as the email CTA — TRIAL_KEY never appears
 * in outbound text. */
export function replySnippet(link: string): string {
  return `Done. Here's your week: ${link}
It refreshes every morning around 8. Tell me what's missing.`;
}

export function pixelSnippet(prospectId: number, campaignId: number, variant: string): string {
  return `<img src="https://motivatedsignal.com/api/t/o?p=${prospectId}&c=${campaignId}&v=${variant}" width="1" height="1" alt="">`;
}

export function adminKeyMatches(provided: string | null | undefined): boolean {
  return Boolean(process.env.ADMIN_KEY) && provided === process.env.ADMIN_KEY;
}

// ---- Send-sheet inbox flags (2026-10-05) — flag, never hide, shared/role inboxes and
// third-party-domain addresses so the founder can judge deliverability before sending. ----

const ROLE_LOCAL_PARTS = new Set([
  'info', 'contact', 'support', 'loans', 'sales', 'getquotes', 'hello', 'office', 'admin',
]);

/** True when the email's local part (before any "+tag") is a generic shared/role inbox
 * (info@, contact@, support@, loans@, sales@, getquotes@, hello@, office@, admin@). */
export function isRoleInboxEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.indexOf('@');
  if (at === -1) return false;
  const local = email.slice(0, at).toLowerCase().split('+')[0];
  return ROLE_LOCAL_PARTS.has(local);
}

function domainOf(value: string): string | null {
  try {
    const u = new URL(value.includes('://') ? value : `https://${value}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** True when the email's domain doesn't match the prospect's own site domain — e.g. a lead-gen
 * form vendor (forms@123-sold.com) instead of the company's own domain. Never flags when there's
 * no site URL to compare against (we'd be guessing). */
export function isThirdPartyDomainEmail(
  email: string | null | undefined,
  siteUrl: string | null | undefined
): boolean {
  if (!email || !siteUrl) return false;
  const at = email.indexOf('@');
  if (at === -1) return false;
  const emailDomain = email.slice(at + 1).toLowerCase();
  const siteDomain = domainOf(siteUrl);
  if (!siteDomain) return false;
  return emailDomain !== siteDomain;
}

export type InboxFlag = 'shared' | 'third-party' | null;

/** Classifies a prospect's send address for the send sheet badge. Role inboxes are flagged
 * ahead of third-party domains when both apply (a role inbox is the more useful warning —
 * "this isn't a person" vs. "this isn't their domain"). Returns null for an ordinary
 * named-person address at the company's own domain. */
export function classifyInboxEmail(
  email: string | null | undefined,
  siteUrl: string | null | undefined
): InboxFlag {
  if (isRoleInboxEmail(email)) return 'shared';
  if (isThirdPartyDomainEmail(email, siteUrl)) return 'third-party';
  return null;
}
