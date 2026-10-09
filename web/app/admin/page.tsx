import type { Metadata } from 'next';
import { turso } from '../../lib/turso';
import { query } from '../../lib/db';
import { getDailyReport } from '../../lib/report';
import {
  ensureOutreachSchema,
  ensureLinkCodes,
  listCampaigns,
  subjectFor,
  firstName,
  emailBody,
  emailBodyWithLeads,
  getLatestMatchDate,
  getMatchesByProspect,
  replySnippet,
  pixelSnippet,
  classifyInboxEmail,
  VARIANTS,
  type Variant,
  type ProspectMatchRow,
} from '../../lib/outreach';
import { CampaignSelect, SegmentSelect, AssignVariantsButton, NewCampaignForm } from './Toolbar';
import SendSheet, { type SendSheetRowData } from './SendSheet';
import WhoEngaged, { type EngagedRow, type EngagementTimelineEntry } from './WhoEngaged';
import s from './admin.module.css';

const SITE = 'https://motivatedsignal.com';

export const metadata: Metadata = { title: 'Admin' };
export const dynamic = 'force-dynamic';

function pct(n: number, denom: number): string {
  if (denom <= 0) return '—';
  return `${Math.round((n / denom) * 1000) / 10}%`;
}

async function getReportNumbers() {
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

const PHOENIX_TZ = 'America/Phoenix';

function phoenixDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PHOENIX_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function phoenixTime(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: PHOENIX_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function phoenixDayLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: PHOENIX_TZ,
    month: 'short',
    day: 'numeric',
  }).format(d);
}

type PipelineStatus = {
  ok: boolean;
  isToday: boolean;
  dayLabel: string;
  startLabel: string;
  endLabel: string;
  nSources: number;
  nOk: number;
  nWarn: number;
  nError: number;
  warnSources: string[];
  errorSources: string[];
};

// Status of the daily GitHub Actions pipeline (06:23 America/Phoenix), read
// from scrape_runs: one row per source per day. "Today" is always computed
// against Phoenix's calendar date via Intl, never host time (Vercel runs UTC).
async function getPipelineStatus(): Promise<PipelineStatus | null> {
  try {
    const res = await query(`
      WITH latest AS (
        SELECT max(started_at) AS latest_started_at FROM scrape_runs
      ),
      day AS (
        SELECT (latest_started_at AT TIME ZONE 'America/Phoenix')::date AS phoenix_day FROM latest
      )
      SELECT
        min(sr.started_at) AS day_started_at,
        max(sr.finished_at) AS day_finished_at,
        count(DISTINCT sr.source)::int AS n_sources,
        count(*) FILTER (WHERE sr.status = 'ok')::int AS n_ok,
        count(*) FILTER (WHERE sr.status = 'warn')::int AS n_warn,
        count(*) FILTER (WHERE sr.status = 'error')::int AS n_error,
        array_agg(sr.source) FILTER (WHERE sr.status = 'warn') AS warn_sources,
        array_agg(sr.source) FILTER (WHERE sr.status = 'error') AS error_sources
      FROM scrape_runs sr, day d
      WHERE (sr.started_at AT TIME ZONE 'America/Phoenix')::date = d.phoenix_day
      GROUP BY d.phoenix_day
    `);
    const row = res.rows[0];
    if (!row || !row.day_started_at) return null;
    const dayStarted = new Date(row.day_started_at);
    const isToday = phoenixDateKey(dayStarted) === phoenixDateKey(new Date());
    return {
      ok: true,
      isToday,
      dayLabel: phoenixDayLabel(dayStarted),
      startLabel: phoenixTime(dayStarted),
      endLabel: row.day_finished_at ? phoenixTime(new Date(row.day_finished_at)) : '—',
      nSources: Number(row.n_sources ?? 0),
      nOk: Number(row.n_ok ?? 0),
      nWarn: Number(row.n_warn ?? 0),
      nError: Number(row.n_error ?? 0),
      warnSources: (row.warn_sources as string[] | null) ?? [],
      errorSources: (row.error_sources as string[] | null) ?? [],
    };
  } catch (err) {
    console.error('getPipelineStatus failed', err);
    return null;
  }
}

function pipelineBannerLine(p: PipelineStatus): string {
  let line = `Pipeline: ran today ${p.startLabel} to ${p.endLabel} Phoenix · ${p.nSources} sources · ${p.nOk} ok`;
  if (p.nWarn > 0) line += ` · ${p.nWarn} warn (${p.warnSources.join(', ')})`;
  if (p.nError > 0) line += ` · ${p.nError} error (${p.errorSources.join(', ')})`;
  return line;
}

type CampaignCounts = {
  assigned: number;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  trials: number;
  paid: number;
  stops: number;
};

async function getCampaignCounts(campaignId: number): Promise<CampaignCounts> {
  const db = turso();
  const [eventsRes, assignedRes] = await Promise.all([
    db.execute({
      sql: `SELECT event, count(DISTINCT prospect_id) AS n FROM outreach_events WHERE campaign_id = ? GROUP BY event`,
      args: [campaignId],
    }),
    db.execute('SELECT count(*) AS n FROM prospects WHERE subject_variant IS NOT NULL'),
  ]);
  const map: Record<string, number> = {};
  for (const r of eventsRes.rows) map[String(r.event)] = Number(r.n);
  return {
    assigned: Number(assignedRes.rows[0]?.n ?? 0),
    sent: map.sent ?? 0,
    opened: map.opened ?? 0,
    clicked: map.clicked ?? 0,
    replied: map.replied ?? 0,
    trials: map.trial ?? 0,
    paid: map.paid ?? 0,
    stops: map.stop ?? 0,
  };
}

type VariantStat = { assigned: number; sent: number; opened: number; clicked: number; replied: number; trials: number };

async function getVariantStats(campaignId: number): Promise<Record<Variant, VariantStat>> {
  const db = turso();
  const [eventsRes, assignedRes] = await Promise.all([
    db.execute({
      sql: `SELECT variant, event, count(DISTINCT prospect_id) AS n FROM outreach_events
            WHERE campaign_id = ? AND variant IS NOT NULL GROUP BY variant, event`,
      args: [campaignId],
    }),
    db.execute(`SELECT subject_variant AS variant, count(*) AS n FROM prospects WHERE subject_variant IS NOT NULL GROUP BY subject_variant`),
  ]);
  const stats = {} as Record<Variant, VariantStat>;
  for (const v of VARIANTS) stats[v] = { assigned: 0, sent: 0, opened: 0, clicked: 0, replied: 0, trials: 0 };
  for (const r of assignedRes.rows) {
    const v = String(r.variant) as Variant;
    if (stats[v]) stats[v].assigned = Number(r.n);
  }
  for (const r of eventsRes.rows) {
    const v = String(r.variant) as Variant;
    if (!stats[v]) continue;
    const n = Number(r.n);
    switch (String(r.event)) {
      case 'sent':
        stats[v].sent = n;
        break;
      case 'opened':
        stats[v].opened = n;
        break;
      case 'clicked':
        stats[v].clicked = n;
        break;
      case 'replied':
        stats[v].replied = n;
        break;
      case 'trial':
        stats[v].trials = n;
        break;
    }
  }
  return stats;
}

const SUBJECT_DISPLAY: Record<Variant, (n7: number) => string> = {
  A: () => 'who filed in maricopa this morning?',
  B: (n7) => `${n7} maricopa filings this week`,
  C: () => `<Company>'s next maricopa seller?`,
  D: () => 'before it hits propstream',
};

type EngagementSummary = { rows: EngagedRow[]; clickedHuman: number; engagedOver30s: number };

/** "Who engaged" dashboard data. Global, not scoped to the selected campaign — page_events has no
 * campaign dimension, since a prospect's /report session isn't tied to which outreach wave sent
 * them there. Clicks come from outreach_events (event='clicked', meta={userAgent,bot} set by
 * web/app/r/[code]/route.ts); page activity comes from page_events, attributed to a prospect only
 * when their signed `ms_pid` cookie verifies server-side in /api/track. */
async function getEngagement(db: ReturnType<typeof turso>): Promise<EngagementSummary> {
  const [prospectsRes, clicksRes, eventsRes] = await Promise.all([
    db.execute('SELECT id, company, contact_name, segment, subject_variant FROM prospects'),
    db.execute(
      `SELECT prospect_id, meta, created_at FROM outreach_events
       WHERE event = 'clicked' AND prospect_id IS NOT NULL ORDER BY created_at ASC`
    ),
    db.execute(
      `SELECT prospect_id, session_id, path, event, meta, ms, created_at FROM page_events
       WHERE prospect_id IS NOT NULL ORDER BY created_at ASC`
    ),
  ]);

  const prospectMeta = new Map<
    number,
    { company: string; contactName: string | null; segment: string | null; variant: string | null }
  >();
  for (const p of prospectsRes.rows) {
    prospectMeta.set(Number(p.id), {
      company: String(p.company ?? ''),
      contactName: (p.contact_name as string | null) ?? null,
      segment: (p.segment as string | null) ?? null,
      variant: (p.subject_variant as string | null) ?? null,
    });
  }

  type Acc = {
    firstClickAt: string | null;
    lastSeen: string;
    humanClicks: number;
    botClicks: number;
    sessions: Set<string>;
    engagedMsOnReport: number;
    pagesVisited: Set<string>;
    rowsExpanded: number;
    exportClicks: number;
    ctaClicks: number;
    timeline: EngagementTimelineEntry[];
  };
  const acc = new Map<number, Acc>();
  function bucket(id: number): Acc {
    let b = acc.get(id);
    if (!b) {
      b = {
        firstClickAt: null,
        lastSeen: '',
        humanClicks: 0,
        botClicks: 0,
        sessions: new Set(),
        engagedMsOnReport: 0,
        pagesVisited: new Set(),
        rowsExpanded: 0,
        exportClicks: 0,
        ctaClicks: 0,
        timeline: [],
      };
      acc.set(id, b);
    }
    return b;
  }

  for (const r of clicksRes.rows) {
    const id = Number(r.prospect_id);
    const b = bucket(id);
    let bot = false;
    try {
      const meta = r.meta ? JSON.parse(String(r.meta)) : {};
      bot = Boolean(meta.bot);
    } catch {
      // malformed meta: treat as human rather than silently dropping the click
    }
    if (bot) b.botClicks += 1;
    else b.humanClicks += 1;
    const createdAt = String(r.created_at ?? '');
    if (!b.firstClickAt || createdAt < b.firstClickAt) b.firstClickAt = createdAt;
    if (createdAt > b.lastSeen) b.lastSeen = createdAt;
    b.timeline.push({ at: createdAt, kind: 'click', event: 'clicked', path: null, bot });
  }

  for (const r of eventsRes.rows) {
    const id = Number(r.prospect_id);
    const b = bucket(id);
    const createdAt = String(r.created_at ?? '');
    const path = (r.path as string | null) ?? null;
    const event = String(r.event ?? '');
    const sessionId = (r.session_id as string | null) ?? null;
    if (sessionId) b.sessions.add(sessionId);
    if (createdAt > b.lastSeen) b.lastSeen = createdAt;
    if (event === 'pageview' && path) b.pagesVisited.add(path);
    if (event === 'engaged_time' && path && path.startsWith('/report')) {
      b.engagedMsOnReport += Number(r.ms ?? 0) || 0;
    }
    if (event === 'row_expand') b.rowsExpanded += 1;
    if (event === 'export_click') b.exportClicks += 1;
    if (event === 'cta_click') b.ctaClicks += 1;
    b.timeline.push({ at: createdAt, kind: 'page', event, path, bot: null });
  }

  const rows: EngagedRow[] = [];
  for (const [id, b] of acc) {
    const meta = prospectMeta.get(id);
    b.timeline.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
    rows.push({
      prospectId: id,
      company: meta?.company || `#${id}`,
      contactName: meta?.contactName ?? null,
      segment: meta?.segment ?? null,
      variant: meta?.variant ?? null,
      firstClickAt: b.firstClickAt,
      lastSeen: b.lastSeen,
      humanClicks: b.humanClicks,
      botClicks: b.botClicks,
      sessions: b.sessions.size,
      engagedMsOnReport: b.engagedMsOnReport,
      pagesVisited: Array.from(b.pagesVisited),
      rowsExpanded: b.rowsExpanded,
      exportClicks: b.exportClicks,
      ctaClicks: b.ctaClicks,
      timeline: b.timeline,
    });
  }
  rows.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));

  return {
    rows,
    clickedHuman: rows.filter((r) => r.humanClicks > 0).length,
    engagedOver30s: rows.filter((r) => r.engagedMsOnReport >= 30000).length,
  };
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; campaign?: string; segment?: string }>;
}) {
  const { key, campaign: campaignParam, segment: segmentParam } = await searchParams;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return <div className={`${s.page} ${s.denied}`}>404</div>;
  }
  const adminKey = key;

  const db = turso();
  await ensureOutreachSchema(db);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS trial_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prospect_id INTEGER,
      user_agent TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await ensureLinkCodes(db);

  const campaigns = await listCampaigns(db);
  const selectedCampaign =
    campaigns.find((c) => String(c.id) === campaignParam) ?? campaigns[0];

  const segmentsRes = await db.execute(
    "SELECT DISTINCT segment FROM prospects WHERE segment IS NOT NULL ORDER BY segment"
  );
  const segments = segmentsRes.rows.map((r) => String(r.segment));
  const segmentFilter = segmentParam && segments.includes(segmentParam) ? segmentParam : '';

  const [
    counts,
    variantStats,
    reportNumbers,
    pipelineStatus,
    prospects,
    requests,
    trialClicks,
    sheetProspects,
    latestMatchDate,
  ] = await Promise.all([
    getCampaignCounts(selectedCampaign.id),
    getVariantStats(selectedCampaign.id),
    getReportNumbers(),
    getPipelineStatus(),
    db.execute('SELECT * FROM prospects ORDER BY rank'),
    db.execute('SELECT * FROM access_requests ORDER BY created_at DESC'),
    db.execute(`
      SELECT tc.id, tc.prospect_id, tc.user_agent, tc.created_at,
             p.company, p.contact_name
      FROM trial_clicks tc
      LEFT JOIN prospects p ON p.id = tc.prospect_id
      ORDER BY tc.created_at DESC
    `),
    db.execute({
      sql: `SELECT id, rank, company, contact_name, segment, email, phone, url, status, subject_variant, link_code
            FROM prospects
            WHERE status <> 'stop' ${segmentFilter ? 'AND segment = ?' : ''}
            ORDER BY rank ASC`,
      args: segmentFilter ? [segmentFilter] : [],
    }),
    getLatestMatchDate(db),
  ]);

  const engagement = await getEngagement(db);

  const matchesByProspect: Map<number, ProspectMatchRow[]> = latestMatchDate
    ? await getMatchesByProspect(db, latestMatchDate)
    : new Map();

  const withEmail = prospects.rows.filter((p) => p.email).length;

  const sendSheetRows: SendSheetRowData[] = sheetProspects.rows.map((p) => {
    const id = Number(p.id);
    const company = String(p.company ?? '');
    const variant = (p.subject_variant as string | null) ?? null;
    const segment = (p.segment as string | null) ?? null;
    const first = firstName(p.contact_name as string | null);
    const linkCode = String(p.link_code ?? '');
    const link = `${SITE}/r/${linkCode}`;
    const subjects = Object.fromEntries(
      VARIANTS.map((v) => [v, subjectFor(v, { n7: reportNumbers.n7, company })])
    ) as Record<'A' | 'B' | 'C' | 'D', string>;

    // Touch 1 carries the prospect's 2 matched leads when they exist for the latest match_date;
    // otherwise fall back to the no-leads body (docs/outreach-plan.md Email A). Both bodies' CTA
    // is the tracked link /r/<code> (web/app/r/[code]/route.ts), never the raw TRIAL_KEY.
    const matches = matchesByProspect.get(id) ?? [];
    const body =
      matches.length >= 2
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

    const email = (p.email as string | null) ?? null;
    const url = (p.url as string | null) ?? null;

    return {
      id,
      rank: Number(p.rank),
      company,
      contactName: (p.contact_name as string | null) ?? null,
      segment,
      email,
      phone: (p.phone as string | null) ?? null,
      url,
      status: String(p.status ?? 'new'),
      variant,
      subjects,
      body,
      reply: replySnippet(link),
      pixel: pixelSnippet(id, selectedCampaign.id, variant ?? 'A'),
      matchDate: matches.length >= 2 ? latestMatchDate : null,
      matches: matches.length >= 2 ? matches.slice(0, 2).map((m) => ({ pitchLine: m.pitchLine, matchTier: m.matchTier })) : null,
      inboxFlag: classifyInboxEmail(email, url),
    };
  });

  // Named-person addresses first within each segment (flagged shared/third-party ones still
  // shown, just sorted after) — segments keep their natural rank-order grouping, and within a
  // bucket the original rank order is preserved.
  const segmentOrder = new Map<string, number>();
  for (const r of sendSheetRows) {
    const key = r.segment ?? '';
    if (!segmentOrder.has(key)) segmentOrder.set(key, segmentOrder.size);
  }
  sendSheetRows.sort((a, b) => {
    const sa = segmentOrder.get(a.segment ?? '') ?? 0;
    const sb = segmentOrder.get(b.segment ?? '') ?? 0;
    if (sa !== sb) return sa - sb;
    const fa = a.inboxFlag ? 1 : 0;
    const fb = b.inboxFlag ? 1 : 0;
    if (fa !== fb) return fa - fb;
    return a.rank - b.rank;
  });

  return (
    <div className={s.page}>
      <main className={s.wrap}>
        <p className={s.eyebrow}>MotivatedSignal · Admin</p>
        <h1 className={s.title}>Outreach console</h1>

        <div
          className={`${s.pipelineBanner} ${
            !pipelineStatus || !pipelineStatus.isToday
              ? s.pipelineRed
              : pipelineStatus.nWarn > 0 || pipelineStatus.nError > 0
                ? s.pipelineAmber
                : s.pipelineGreen
          }`}
        >
          <p className={s.pipelineLine}>
            {!pipelineStatus ? (
              <>
                Pipeline has NOT run today (no runs recorded). Run it: <code>gh workflow run daily.yml</code>
              </>
            ) : pipelineStatus.isToday ? (
              pipelineBannerLine(pipelineStatus)
            ) : (
              <>
                Pipeline has NOT run today (last run {pipelineStatus.dayLabel} {pipelineStatus.startLabel}). Run
                it: <code>gh workflow run daily.yml</code>
              </>
            )}
          </p>
          <p className={s.pipelineMeta}>
            {reportNumbers.ok
              ? `${reportNumbers.n24} new in last 24h · ${reportNumbers.n7} new this week`
              : 'Report numbers unavailable'}
          </p>
        </div>

        <section className={s.section}>
          <h2 className={s.sectionTitle}>Who engaged ({engagement.rows.length})</h2>
          <p className={s.meta}>
            Anyone who clicked a tracked link or generated a page event, newest first. Bot-flagged
            clicks (link scanners) are shown separately and never count as a real click.
          </p>
          <WhoEngaged rows={engagement.rows} />
        </section>

        <section className={s.section}>
          <div className={s.toolbar}>
            <CampaignSelect campaigns={campaigns} selectedId={selectedCampaign.id} adminKey={adminKey} />
            <NewCampaignForm adminKey={adminKey} />
          </div>
          <p className={s.meta}>
            {reportNumbers.ok
              ? `${reportNumbers.n24} filings in the last 24h · ${reportNumbers.s} stacked 2+ this week`
              : 'Report numbers unavailable — CockroachDB query failed.'}
          </p>
          <div className={s.statGrid}>
            <div className={s.statTile}>
              <p className={s.statValue}>{counts.assigned}</p>
              <p className={s.statLabel}>Assigned</p>
            </div>
            <div className={s.statTile}>
              <p className={s.statValue}>{counts.sent}</p>
              <p className={s.statLabel}>Sent</p>
            </div>
            <div className={s.statTile}>
              <p className={s.statValue}>{counts.opened}</p>
              <p className={s.statLabel}>Opened</p>
              <p className={s.statRate}>{pct(counts.opened, counts.sent)} of sent</p>
            </div>
            <div className={s.statTile}>
              <p className={s.statValue}>{counts.clicked}</p>
              <p className={s.statLabel}>Clicked</p>
              <p className={s.statRate}>{pct(counts.clicked, counts.sent)} of sent</p>
            </div>
            <div className={s.statTile}>
              <p className={s.statValue}>{engagement.clickedHuman}</p>
              <p className={s.statLabel}>Clicked (human)</p>
              <p className={s.statRate}>bot clicks excluded</p>
            </div>
            <div className={s.statTile}>
              <p className={s.statValue}>{engagement.engagedOver30s}</p>
              <p className={s.statLabel}>Engaged &gt;30s</p>
              <p className={s.statRate}>on /report</p>
            </div>
            <div className={s.statTile}>
              <p className={s.statValue}>{counts.replied}</p>
              <p className={s.statLabel}>Replied</p>
              <p className={s.statRate}>{pct(counts.replied, counts.sent)} of sent</p>
            </div>
            <div className={s.statTile}>
              <p className={s.statValue}>{counts.trials}</p>
              <p className={s.statLabel}>Trials</p>
              <p className={s.statRate}>{pct(counts.trials, counts.sent)} of sent</p>
            </div>
            <div className={s.statTile}>
              <p className={s.statValue}>{counts.paid}</p>
              <p className={s.statLabel}>Paid</p>
              <p className={s.statRate}>{pct(counts.paid, counts.sent)} of sent</p>
            </div>
            <div className={s.statTile}>
              <p className={s.statValue}>{counts.stops}</p>
              <p className={s.statLabel}>Stops</p>
              <p className={s.statRate}>{pct(counts.stops, counts.sent)} of sent</p>
            </div>
          </div>
        </section>

        <section className={s.section}>
          <h2 className={s.sectionTitle}>Subject line test (A/B/C/D)</h2>
          <p className={s.meta}>Rates are of sent, for the selected campaign.</p>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Variant</th>
                  <th>Subject</th>
                  <th>Assigned</th>
                  <th>Sent</th>
                  <th>Open %</th>
                  <th>Click %</th>
                  <th>Reply %</th>
                  <th>Trials</th>
                </tr>
              </thead>
              <tbody>
                {VARIANTS.map((v) => {
                  const st = variantStats[v];
                  return (
                    <tr key={v}>
                      <td className={s.mono}>{v}</td>
                      <td>{SUBJECT_DISPLAY[v](reportNumbers.n7)}</td>
                      <td className={s.mono}>{st.assigned}</td>
                      <td className={s.mono}>{st.sent}</td>
                      <td className={s.mono}>{pct(st.opened, st.sent)}</td>
                      <td className={s.mono}>{pct(st.clicked, st.sent)}</td>
                      <td className={s.mono}>{pct(st.replied, st.sent)}</td>
                      <td className={s.mono}>{st.trials}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className={s.noteSmall}>
            With roughly 23 sends per arm, differences under about 10 percentage points are noise. Keep the
            test running across touches and future lists before calling a winner.
          </p>
          <div className={s.inlineAction}>
            <AssignVariantsButton adminKey={adminKey} />
          </div>
        </section>

        <section className={s.section} id="send-sheet">
          <h2 className={s.sectionTitle}>Send sheet ({sendSheetRows.length})</h2>
          <p className={s.meta}>Stop-flagged prospects are hidden. Expand a row for the filled email.</p>
          <div className={s.toolbar}>
            <SegmentSelect segments={segments} selected={segmentFilter} adminKey={adminKey} />
          </div>
          <SendSheet rows={sendSheetRows} campaignId={selectedCampaign.id} adminKey={adminKey} />
        </section>

        <section className={s.section}>
          <h2 className={s.sectionTitle}>Access requests ({requests.rows.length})</h2>
          <p className={s.meta}>People who submitted the landing-page form — hottest inbound first.</p>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Segment</th>
                  <th>Source</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {requests.rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className={s.dim}>
                      None yet — send the first cold emails.
                    </td>
                  </tr>
                ) : (
                  requests.rows.map((r) => (
                    <tr key={String(r.id)}>
                      <td className={s.mono}>
                        <a className={s.link} href={`mailto:${r.email}`}>
                          {String(r.email)}
                        </a>
                      </td>
                      <td>{r.segment ? <span className={s.segment}>{String(r.segment)}</span> : '—'}</td>
                      <td className={s.mono}>{String(r.source ?? '—')}</td>
                      <td className={s.mono}>{String(r.created_at ?? '')}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className={s.section}>
          <h2 className={s.sectionTitle}>Trial clicks ({trialClicks.rows.length})</h2>
          <p className={s.meta}>Cold-email prospects who clicked a 7-day trial link.</p>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>User agent</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {trialClicks.rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className={s.dim}>
                      None yet.
                    </td>
                  </tr>
                ) : (
                  trialClicks.rows.map((c) => (
                    <tr key={String(c.id)}>
                      <td>
                        {c.prospect_id == null ? (
                          <span className={s.dim}>direct</span>
                        ) : c.company ? (
                          String(c.company)
                        ) : (
                          <span className={s.dim}>—</span>
                        )}
                      </td>
                      <td>{c.contact_name ? String(c.contact_name) : <span className={s.dim}>—</span>}</td>
                      <td className={s.mono}>{c.user_agent ? String(c.user_agent) : <span className={s.dim}>—</span>}</td>
                      <td className={s.mono}>{String(c.created_at ?? '')}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className={s.section}>
          <h2 className={s.sectionTitle}>Prospects ({prospects.rows.length})</h2>
          <p className={s.meta}>
            {withEmail} with direct email · ranked by outreach priority · sourced from public company sites
          </p>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Company</th>
                  <th>Contact</th>
                  <th>Segment</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Site</th>
                  <th>Variant</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {prospects.rows.map((p) => (
                  <tr key={String(p.id)}>
                    <td className={s.mono}>{String(p.rank)}</td>
                    <td>{String(p.company)}</td>
                    <td>{p.contact_name ? String(p.contact_name) : <span className={s.dim}>—</span>}</td>
                    <td>
                      <span className={s.segment}>{String(p.segment ?? '—')}</span>
                    </td>
                    <td className={s.mono}>
                      {p.email ? (
                        <a className={s.link} href={`mailto:${p.email}`}>
                          {String(p.email)}
                        </a>
                      ) : (
                        <span className={s.dim}>—</span>
                      )}
                    </td>
                    <td className={s.mono}>{p.phone ? String(p.phone) : <span className={s.dim}>—</span>}</td>
                    <td className={s.mono}>
                      {p.url ? (
                        <a className={s.link} href={String(p.url)} target="_blank" rel="noreferrer">
                          site ↗
                        </a>
                      ) : (
                        <span className={s.dim}>—</span>
                      )}
                    </td>
                    <td className={s.mono}>{p.subject_variant ? String(p.subject_variant) : <span className={s.dim}>—</span>}</td>
                    <td>
                      <span className={s.segment}>{String(p.status ?? 'new')}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
