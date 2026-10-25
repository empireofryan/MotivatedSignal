import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../../lib/turso';
import { query } from '../../../../lib/db';
import { adminKeyMatches, ensureOutreachSchema, getLatestCampaign } from '../../../../lib/outreach';
import { evaluateStop, phoenixDateString, phoenixDayBoundsUtc, rampN, remainingToSend } from '../../../../lib/outreach-logic';

// GET /api/admin/pipeline-status — preflight for the automated sender (x-admin-key header).
// Reports whether today's (Phoenix) daily run recorded recorder_nots ok/warn, how many send days
// and sends have happened, the ramp target, and whether stop/bounce conditions say to halt.
// Optional ?n=<override> applies the manual override to `remaining`. Counts only; no PII.
export const dynamic = 'force-dynamic';

// Phoenix date of an outreach_events.created_at (stored as UTC 'YYYY-MM-DD HH:MM:SS').
const PHX_DAY = "date(created_at, '-7 hours')";

export async function GET(request: NextRequest) {
  if (!adminKeyMatches(request.headers.get('x-admin-key'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  try {
    const db = turso();
    await ensureOutreachSchema(db);
    const campaign = await getLatestCampaign(db);
    const now = new Date();
    const today = phoenixDateString(now);
    const { start, end } = phoenixDayBoundsUtc(now);

    const run = await query(
      `SELECT 1 FROM scrape_runs
       WHERE source = 'recorder_nots' AND status IN ('ok','warn') AND started_at >= $1 AND started_at < $2 LIMIT 1`,
      [start, end]
    );

    const [days, sentToday, prev, totals] = await Promise.all([
      db.execute(`SELECT count(DISTINCT ${PHX_DAY}) AS n FROM outreach_events WHERE event = 'sent'`),
      db.execute({
        sql: `SELECT count(DISTINCT prospect_id) AS n FROM outreach_events WHERE event = 'sent' AND ${PHX_DAY} = ?`,
        args: [today],
      }),
      db.execute({
        sql: `SELECT max(${PHX_DAY}) AS d FROM outreach_events WHERE event = 'sent' AND ${PHX_DAY} < ?`,
        args: [today],
      }),
      db.execute(
        `SELECT
           count(DISTINCT CASE WHEN event = 'sent' THEN prospect_id END) AS sent,
           count(DISTINCT CASE WHEN event = 'bounced' THEN prospect_id END) AS bounced
         FROM outreach_events`
      ),
    ]);

    const prevDay = (prev.rows[0]?.d as string | null) ?? null;
    let stops = 0;
    let bounces = 0;
    if (prevDay) {
      // Start of the previous send day in Phoenix = 07:00 UTC.
      const since = await db.execute({
        sql: `SELECT
                coalesce(sum(event = 'stop'), 0) AS stops,
                coalesce(sum(event = 'bounced'), 0) AS bounces
              FROM outreach_events
              WHERE event IN ('stop','bounced') AND created_at >= datetime(? || ' 07:00:00')`,
        args: [prevDay],
      });
      stops = Number(since.rows[0]?.stops ?? 0);
      bounces = Number(since.rows[0]?.bounces ?? 0);
    }

    const stop = evaluateStop({
      stopsSincePrevSendDay: stops,
      bouncesSincePrevSendDay: bounces,
      sentTotal: Number(totals.rows[0]?.sent ?? 0),
      bouncedTotal: Number(totals.rows[0]?.bounced ?? 0),
    });

    const overrideRaw = request.nextUrl.searchParams.get('n');
    const override = overrideRaw ? Number(overrideRaw) : null;
    const sendDays = Number(days.rows[0]?.n ?? 0);
    const sent = Number(sentToday.rows[0]?.n ?? 0);
    const target = rampN(sendDays, override);

    return NextResponse.json(
      {
        phoenix_date: today,
        campaign_id: campaign.id,
        pipeline_ran_today: run.rows.length > 0,
        send_days: sendDays,
        sent_today: sent,
        target,
        remaining: remainingToSend(target, sent, override !== null && override > 0),
        halt: stop.halt,
        halt_reason: stop.reason,
      },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (err) {
    console.error('pipeline-status failed', err);
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
}
