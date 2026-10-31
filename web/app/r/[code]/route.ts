import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../lib/turso';
import {
  getLatestCampaign,
  getProspectByLinkCode,
  logEvent,
  signProspectId,
} from '../../../lib/outreach';
import { randomVid } from '../../../lib/access';
import { isBotUserAgent } from '../../../lib/bot';

// Tracked touch-1 link: /r/<code> resolves the 8-char code to a prospect and logs a `clicked`
// outreach_event (with a bot flag). It does NOT start the trial: mail-gateway sandboxes (Defender
// Safe Links and friends) open every link with a normal Chrome UA within a minute of delivery and
// burned each prospect's one-and-only trial (2026-10-26..29). The trial now starts from
// /api/trial/activate, which TrialActivator on /report calls only after real pointer/touch/key
// input. Also stamps visitor-identity cookies (`ms_pid` signed, `ms_vid` anonymous) so /api/track can
// attribute later /report activity back to this prospect. Unknown codes fall through to
// /pricing without logging anything.
export const dynamic = 'force-dynamic';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

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

  if (bot) console.warn('[r/code] bot-flagged click', { code, userAgent });

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
