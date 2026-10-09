import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../../lib/turso';
import { adminKeyMatches, ensureOutreachSchema } from '../../../../lib/outreach';

// POST /api/admin/campaign — create a new campaign (e.g. a new touch / send wave).
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

  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
  const touch = typeof b.touch === 'number' ? b.touch : Number(b.touch ?? 1);
  if (!name || !Number.isFinite(touch)) {
    return NextResponse.json({ error: 'bad input' }, { status: 400 });
  }

  const db = turso();
  await ensureOutreachSchema(db);
  const res = await db.execute({
    sql: 'INSERT INTO campaigns (name, touch) VALUES (?, ?)',
    args: [name, Math.trunc(touch)],
  });
  return NextResponse.json({ ok: true, id: Number(res.lastInsertRowid) });
}
