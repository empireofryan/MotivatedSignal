import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../lib/turso';
import { getLatestCampaign, logEvent } from '../../../lib/outreach';
import { randomVid, startOrReuseTrial, setTrialCookies } from '../../../lib/access';

// Manual trial link: /api/trial?k=TRIAL_KEY[&p=<prospect id>]. Generic (no `p`) grants/reuses a
// trial keyed by the visitor's `ms_vid` cookie (minted here if missing); `p` grants/reuses one
// keyed by that prospect instead. Either way a trial is never extended on repeat use — see
// startOrReuseTrial. Cold-email prospects now get this via the tracked /r/<code> link instead
// (TRIAL_KEY never appears in an email); this route stays for manual/admin use.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('k') ?? '';
  const pRaw = request.nextUrl.searchParams.get('p');
  const url = new URL('/report', request.url);

  if (!process.env.TRIAL_KEY || key !== process.env.TRIAL_KEY) {
    url.pathname = '/pricing';
    return NextResponse.redirect(url);
  }

  const prospectId = pRaw != null && /^\d+$/.test(pRaw) ? Number(pRaw) : null;
  const userAgent = request.headers.get('user-agent') ?? null;
  const db = turso();

  const existingVid = request.cookies.get('ms_vid')?.value ?? null;
  const vid = prospectId == null ? existingVid ?? randomVid() : null;

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
      args: [prospectId, userAgent],
    });
    if (prospectId != null) {
      await db.execute({
        sql: "UPDATE prospects SET status = 'trial' WHERE id = ? AND status = 'new'",
        args: [prospectId],
      });
      const variantRow = await db.execute({
        sql: 'SELECT subject_variant FROM prospects WHERE id = ?',
        args: [prospectId],
      });
      const variant = (variantRow.rows[0]?.subject_variant as string | null) ?? null;
      const campaign = await getLatestCampaign(db);
      await logEvent(db, { prospectId, campaignId: campaign.id, variant, event: 'trial' });
    }
  } catch (err) {
    // Never block the trial redirect on logging failures.
    console.error('trial_clicks insert failed', err);
  }

  const trial = await startOrReuseTrial(db, { prospectId, vid, source: 'trial_key' });

  const res = NextResponse.redirect(url);
  setTrialCookies(res, trial);
  if (vid && !existingVid) {
    res.cookies.set('ms_vid', vid, {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}
