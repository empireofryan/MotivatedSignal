import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../../lib/turso';
import { logOpen } from '../../../../lib/outreach';

// 1x1 transparent tracking pixel: /api/t/o?p=<prospect>&c=<campaign>&v=<variant>
// Logs an 'opened' event (deduped to one per prospect+campaign per rolling hour) and
// always returns the gif, even if the DB write fails.
export const dynamic = 'force-dynamic';

// GIF89a, 1x1, transparent.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64'
);

function gifResponse() {
  return new NextResponse(new Uint8Array(PIXEL), {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store',
      'Content-Length': String(PIXEL.length),
    },
  });
}

export async function GET(request: NextRequest) {
  const pRaw = request.nextUrl.searchParams.get('p');
  const cRaw = request.nextUrl.searchParams.get('c');
  const variant = request.nextUrl.searchParams.get('v');

  const prospectId = pRaw != null && /^\d+$/.test(pRaw) ? Number(pRaw) : null;
  const campaignId = cRaw != null && /^\d+$/.test(cRaw) ? Number(cRaw) : null;

  if (prospectId != null && campaignId != null) {
    try {
      await logOpen(turso(), prospectId, campaignId, variant);
    } catch (err) {
      console.error('pixel open log failed', err);
    }
  }

  return gifResponse();
}
