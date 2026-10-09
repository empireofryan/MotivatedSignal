import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../../lib/turso';
import { ADMIN_EVENTS, adminKeyMatches, logEvent, type OutreachEvent } from '../../../../lib/outreach';

// POST /api/admin/event — manually log a sent/replied/stop/bounced/paid event from the admin
// send sheet. Key via header x-admin-key or body.key.
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad input' }, { status: 400 });
  }
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const key = request.headers.get('x-admin-key') ?? (typeof b.key === 'string' ? b.key : null);
  if (!adminKeyMatches(key)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const prospectId = typeof b.prospect_id === 'number' ? b.prospect_id : Number(b.prospect_id);
  const campaignId = typeof b.campaign_id === 'number' ? b.campaign_id : Number(b.campaign_id);
  const event = typeof b.event === 'string' ? (b.event as OutreachEvent) : null;

  if (!Number.isFinite(prospectId) || !Number.isFinite(campaignId) || !event || !ADMIN_EVENTS.includes(event)) {
    return NextResponse.json({ error: 'bad input' }, { status: 400 });
  }

  const db = turso();
  const variantRow = await db.execute({
    sql: 'SELECT subject_variant, status FROM prospects WHERE id = ?',
    args: [prospectId],
  });
  if (variantRow.rows.length === 0) {
    return NextResponse.json({ error: 'unknown prospect' }, { status: 404 });
  }
  const variant = (variantRow.rows[0].subject_variant as string | null) ?? null;
  const currentStatus = (variantRow.rows[0].status as string | null) ?? 'new';

  await logEvent(db, { prospectId, campaignId, variant, event });

  if (event === 'stop') {
    await db.execute({ sql: "UPDATE prospects SET status = 'stop' WHERE id = ?", args: [prospectId] });
  } else if (event === 'replied') {
    if (!['trial', 'paid', 'stop'].includes(currentStatus)) {
      await db.execute({ sql: "UPDATE prospects SET status = 'replied' WHERE id = ?", args: [prospectId] });
    }
  } else if (event === 'sent') {
    if (currentStatus === 'new') {
      await db.execute({ sql: "UPDATE prospects SET status = 'sent' WHERE id = ?", args: [prospectId] });
    }
  }

  return NextResponse.json({ ok: true });
}
