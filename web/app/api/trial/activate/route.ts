import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../../lib/turso';
import { getLatestCampaign, logEvent, verifyProspectId } from '../../../../lib/outreach';
import { startOrReuseTrial, setTrialCookies } from '../../../../lib/access';
import { isBotUserAgent } from '../../../../lib/bot';

// Starts a prospect's one-and-only 7-day trial. Called by TrialActivator on /report after the
// first real pointer/touch/wheel/key input, never by the /r/<code> redirect itself, so mail-gateway
// sandboxes that open the link without interacting never burn the trial. The prospect comes only
// from the signed ms_pid cookie set by /r/<code>; nothing client-supplied is trusted.
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const prospectId = verifyProspectId(request.cookies.get('ms_pid')?.value ?? null);
  if (prospectId == null) return NextResponse.json({ ok: false }, { status: 400 });
  const userAgent = request.headers.get('user-agent');
  if (isBotUserAgent(userAgent)) return NextResponse.json({ ok: false }, { status: 403 });

  const db = turso();
  const res = NextResponse.json({ ok: true });
  try {
    const trial = await startOrReuseTrial(db, { prospectId, source: 'r_code' });
    setTrialCookies(res, trial);
    if (trial.isNew) {
      await db.execute({
        sql: 'INSERT INTO trial_clicks (prospect_id, user_agent) VALUES (?, ?)',
        args: [prospectId, userAgent],
      });
      await db.execute({
        sql: "UPDATE prospects SET status = 'trial' WHERE id = ? AND status = 'new'",
        args: [prospectId],
      });
      const v = await db.execute({ sql: 'SELECT subject_variant FROM prospects WHERE id = ?', args: [prospectId] });
      const campaign = await getLatestCampaign(db);
      const variant = (v.rows[0]?.subject_variant as string | null) ?? null;
      await logEvent(db, { prospectId, campaignId: campaign.id, variant, event: 'trial' });
    }
  } catch (err) {
    console.error('[trial/activate] failed', err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  return res;
}
