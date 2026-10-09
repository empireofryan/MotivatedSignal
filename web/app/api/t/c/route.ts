import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../../lib/turso';
import { logEvent } from '../../../../lib/outreach';

// Click-through redirect: /api/t/c?p=<prospect>&c=<campaign>&v=<variant>&u=<destination>
// Logs a 'clicked' event, then 302s to u (only if it's a motivatedsignal.com URL; else to /).
export const dynamic = 'force-dynamic';

const SAFE_PREFIX = 'https://motivatedsignal.com/';

export async function GET(request: NextRequest) {
  const pRaw = request.nextUrl.searchParams.get('p');
  const cRaw = request.nextUrl.searchParams.get('c');
  const variant = request.nextUrl.searchParams.get('v');
  const target = request.nextUrl.searchParams.get('u') ?? '';

  const prospectId = pRaw != null && /^\d+$/.test(pRaw) ? Number(pRaw) : null;
  const campaignId = cRaw != null && /^\d+$/.test(cRaw) ? Number(cRaw) : null;

  if (prospectId != null && campaignId != null) {
    try {
      await logEvent(turso(), { prospectId, campaignId, variant, event: 'clicked' });
    } catch (err) {
      console.error('click log failed', err);
    }
  }

  const destination = target.startsWith(SAFE_PREFIX) ? target : new URL('/', request.url).toString();
  return NextResponse.redirect(destination, 302);
}
