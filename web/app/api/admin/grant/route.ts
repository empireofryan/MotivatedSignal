import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../../lib/turso';
import { adminKeyMatches } from '../../../../lib/outreach';
import { ensureAccessSchema, randomCustomerKey } from '../../../../lib/access';

// POST /api/admin/grant — create/reactivate a Pro customer, or revoke one. ADMIN_KEY via the
// `x-admin-key` header. Body: { email, name? } to grant, or { email, revoke: true } to revoke.
// This is the HTTP sibling of web/scripts/grant-pro.mjs (same logic, for when a shell on this
// machine isn't handy — e.g. triggering a grant from the admin dashboard later).
export const dynamic = 'force-dynamic';

const SITE = 'https://motivatedsignal.com';

export async function POST(request: NextRequest) {
  const key = request.headers.get('x-admin-key');
  if (!adminKeyMatches(key)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'bad input' }, { status: 400 });
  }
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const name = typeof b.name === 'string' ? b.name.trim() : null;
  const revoke = b.revoke === true;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'bad email' }, { status: 400 });
  }

  const db = turso();
  await ensureAccessSchema(db);

  if (revoke) {
    const existing = await db.execute({ sql: 'SELECT id FROM customers WHERE email = ?', args: [email] });
    if (existing.rows.length === 0) {
      return NextResponse.json({ error: 'unknown customer' }, { status: 404 });
    }
    await db.execute({
      sql: "UPDATE customers SET status = 'canceled', updated_at = datetime('now') WHERE email = ?",
      args: [email],
    });
    return NextResponse.json({ ok: true, email, status: 'canceled' });
  }

  const existing = await db.execute({ sql: 'SELECT id, key FROM customers WHERE email = ?', args: [email] });
  let customerKey: string;
  if (existing.rows.length > 0) {
    customerKey = String(existing.rows[0].key);
    await db.execute({
      sql: "UPDATE customers SET status = 'active', name = COALESCE(?, name), updated_at = datetime('now') WHERE email = ?",
      args: [name, email],
    });
  } else {
    customerKey = randomCustomerKey();
    await db.execute({
      sql: 'INSERT INTO customers (email, name, key, status) VALUES (?, ?, ?, ?)',
      args: [email, name, customerKey, 'active'],
    });
  }

  return NextResponse.json({ ok: true, email, key: customerKey, link: `${SITE}/api/pro?key=${customerKey}` });
}
