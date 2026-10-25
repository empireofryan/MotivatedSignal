import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../../lib/turso';
import { adminKeyMatches } from '../../../../lib/outreach';
import { getNextBatch } from '../../../../lib/outreach-batch';
import { HARD_DAILY_CAP } from '../../../../lib/outreach-logic';

// GET /api/admin/next-batch?n=10 — the next N prospects to email for the latest campaign, rendered
// exactly like the /admin send sheet. Header x-admin-key required. Read-only (apart from the
// idempotent link-code backfill the send sheet also does).
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!adminKeyMatches(request.headers.get('x-admin-key'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const raw = Number(request.nextUrl.searchParams.get('n') ?? '10');
  const n = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), HARD_DAILY_CAP) : 10;
  try {
    const items = await getNextBatch(turso(), n);
    return NextResponse.json(items, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('next-batch failed', err);
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
}
