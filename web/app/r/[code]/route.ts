import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../lib/turso';
import {
  getLatestCampaign,
  getProspectByLinkCode,
  logEvent,
  signProspectId,
} from '../../../lib/outreach';
import { randomVid, startOrReuseTrial, setTrialCookies } from '../../../lib/access';

// Tracked touch-1 link: /r/<code> resolves the 8-char code to a prospect, logs a `clicked`
// outreach_event (with a bot flag — see isBotClick below), then grants a trial exactly like
// /api/trial?p=<id>&k=<TRIAL_KEY> used to — MINUS ever putting TRIAL_KEY in an email, MINUS ever
// extending the trial on repeat clicks, and MINUS granting anything at all to a bot click. Also
// stamps visitor-identity cookies (`ms_pid` signed, `ms_vid` anonymous) so /api/track can
// attribute later /report activity back to this prospect. Unknown codes fall through to
// /pricing without logging anything.
export const dynamic = 'force-dynamic';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// Known link-scanner / security-gateway user agents that prefetch links from inside an email
// before a human ever opens it. These should never count as a real click, and must never start
// a trial (a prospect's one-and-only trial would otherwise get burned by their own mail gateway).
const BOT_UA_PATTERNS: RegExp[] = [
  /barracuda/i,
  /proofpoint/i,
  /mimecast/i,
  /microsoft.?defender/i,
  /safelinks/i, // Microsoft Defender for Office 365 "Safe Links" prefetcher
  /googleimageproxy/i, // Gmail's image-proxy UA also prefetches plain links in some configs
];

function isBotUserAgent(ua: string | null): boolean {
  if (!ua || ua.trim() === '') return true;
  return BOT_UA_PATTERNS.some((re) => re.test(ua));
}

/** True if the most recent 'sent' event for this prospect happened within the last 5 seconds —
 * i.e. this "click" fired before a human could plausibly have opened the email. */
async function clickedTooSoonAfterSend(db: ReturnType<typeof turso>, prospectId: number): Promise<boolean> {
  try {
    const res = await db.execute({
      sql: `SELECT created_at FROM outreach_events WHERE prospect_id = ? AND event = 'sent'
            ORDER BY created_at DESC LIMIT 1`,
      args: [prospectId],
    });
    const sentAt = res.rows[0]?.created_at as string | undefined;
    if (!sentAt) return false;
    const normalized = sentAt.includes('T') ? sentAt : sentAt.replace(' ', 'T');
    const sentMs = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`).getTime();
    if (Number.isNaN(sentMs)) return false;
    return Date.now() - sentMs < 5000;
  } catch (err) {
    console.error('clickedTooSoonAfterSend failed', err);
    return false;
  }
}

export async function GET(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  const db = turso();

  const prospect = code ? await getProspectByLinkCode(db, code).catch((err) => {
    console.error('getProspectByLinkCode failed', err);
    return null;
  }) : null;

  if (!prospect) {
    return NextResponse.redirect(new URL('/pricing', request.url));
  }

  const userAgent = request.headers.get('user-agent');
  const bot = isBotUserAgent(userAgent) || (await clickedTooSoonAfterSend(db, prospect.id));

  try {
    const campaign = await getLatestCampaign(db);
    await logEvent(db, {
      prospectId: prospect.id,
      campaignId: campaign.id,
      variant: prospect.variant,
      event: 'clicked',
      meta: JSON.stringify({ userAgent, bot }),
    });
  } catch (err) {
    console.error('clicked log failed', err);
  }

  const res = NextResponse.redirect(new URL('/report', request.url));

  if (bot) {
    console.warn('[r/code] bot-flagged click — not starting a trial', { code, userAgent });
  } else {
    // One trial per prospect, ever: startOrReuseTrial returns the existing row unchanged if this
    // prospect already clicked before (even if it has since expired), and only creates a new
    // 7-day trial the first time. The cookie always reflects whatever row comes back, so a
    // post-expiry click still carries the real ends_at for the report page's "trial ended" copy.
    try {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS trial_clicks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prospect_id INTEGER,
          user_agent TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      await db.execute({
        sql: 'INSERT INTO trial_clicks (prospect_id, user_agent) VALUES (?, ?)',
        args: [prospect.id, userAgent],
      });
      await db.execute({
        sql: "UPDATE prospects SET status = 'trial' WHERE id = ? AND status = 'new'",
        args: [prospect.id],
      });
      const campaign = await getLatestCampaign(db);
      await logEvent(db, { prospectId: prospect.id, campaignId: campaign.id, variant: prospect.variant, event: 'trial' });

      const trial = await startOrReuseTrial(db, { prospectId: prospect.id, source: 'r_code' });
      setTrialCookies(res, trial);
    } catch (err) {
      // Never block the redirect on logging/trial failures.
      console.error('trial grant failed', err);
    }
  }

  // Visitor identity: ms_pid ties future /api/track activity back to this prospect; ms_vid covers
  // anonymous traffic too (set here since this is also this visitor's first-ever page hit).
  res.cookies.set('ms_pid', signProspectId(prospect.id), {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
  });
  if (!request.cookies.get('ms_vid')) {
    res.cookies.set('ms_vid', randomVid(), {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ONE_YEAR_SECONDS,
    });
  }

  return res;
}
