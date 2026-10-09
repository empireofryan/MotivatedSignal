import { NextRequest, NextResponse } from 'next/server';
import { turso } from '../../../lib/turso';
import { ensureAccessSchema, setProCookie, setLegacyProCookie, LEGACY_PRO_KEY_CUTOFF } from '../../../lib/access';

// Pro access link: /api/pro?key=<customer key> sets a signed, per-customer cookie and lands on
// the full report. Keys come from `customers.key` (created via /api/admin/grant or
// web/scripts/grant-pro.mjs after a Stripe checkout — see web/app/api/stripe/webhook/route.ts).
// A customer whose status isn't 'active' (canceled/past_due) gets bounced to /pricing even with
// a valid key — the key alone isn't enough, status is re-checked on every /report request too.
//
// Back-compat: the OLD shared PRO_KEY env value still works as a fallback, but only until
// LEGACY_PRO_KEY_CUTOFF — see web/lib/access.ts for why and the removal plan.
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key') ?? '';
  const url = new URL('/report', request.url);

  if (!key) {
    url.pathname = '/pricing';
    return NextResponse.redirect(url);
  }

  const db = turso();
  await ensureAccessSchema(db);
  const row = await db.execute({ sql: 'SELECT id, status FROM customers WHERE key = ?', args: [key] });

  if (row.rows.length > 0) {
    const customerId = Number(row.rows[0].id);
    const status = String(row.rows[0].status ?? 'active');
    if (status !== 'active') {
      url.pathname = '/pricing';
      return NextResponse.redirect(url);
    }
    const res = NextResponse.redirect(url);
    setProCookie(res, customerId);
    return res;
  }

  if (process.env.PRO_KEY && key === process.env.PRO_KEY && Date.now() < LEGACY_PRO_KEY_CUTOFF.getTime()) {
    console.warn(
      `[api/pro] legacy shared PRO_KEY used — this stops working ${LEGACY_PRO_KEY_CUTOFF.toISOString()}`
    );
    const res = NextResponse.redirect(url);
    setLegacyProCookie(res, key);
    return res;
  }

  url.pathname = '/pricing';
  return NextResponse.redirect(url);
}
