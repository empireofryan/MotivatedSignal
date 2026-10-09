import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { turso } from '../../../../lib/turso';
import { ensureAccessSchema, randomCustomerKey } from '../../../../lib/access';

// POST /api/stripe/webhook — no `stripe` SDK (see repo-wide "no direct LLM/paid-SDK calls"
// posture; here it's just "don't add a dependency for ~30 lines of HMAC"). Signature verified by
// hand per Stripe's documented scheme: https://docs.stripe.com/webhooks#verify-manually
//   signedPayload = "<timestamp>.<rawBody>"
//   expected      = HMAC-SHA256(endpointSecret, signedPayload), hex
//   header        = "t=<timestamp>,v1=<sig>[,v1=<sig>...][,v0=...]"  — accept any v1 match
//   tolerance     = reject if |now - timestamp| > 5 minutes
//
// STRIPE_WEBHOOK_SECRET is intentionally left UNSET until Ryan creates the endpoint in the
// Stripe dashboard (see this file's header comment reproduced in the PR/report) — until then
// this returns 503 rather than silently accepting unverified requests.
export const dynamic = 'force-dynamic';

const TOLERANCE_SECONDS = 5 * 60;

function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') timestamp = Number(v);
    else if (k === 'v1') signatures.push(v);
  }
  if (timestamp == null || Number.isNaN(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function verifySignature(rawBody: string, header: string, secret: string): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const { timestamp, signatures } = parsed;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false;

  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const expected = Buffer.from(expectedHex, 'hex');

  return signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

type StripeObject = Record<string, unknown>;
type StripeEvent = { id?: string; type: string; data?: { object?: StripeObject } };

function str(obj: StripeObject, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

type CustomerStatus = 'active' | 'canceled' | 'past_due';

function mapSubscriptionStatus(stripeStatus: string | null): CustomerStatus | null {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'incomplete':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return null;
  }
}

async function setStatusByStripeIds(
  db: ReturnType<typeof turso>,
  ids: { stripeCustomerId: string | null; stripeSubscriptionId: string | null },
  status: CustomerStatus
): Promise<void> {
  const { stripeCustomerId, stripeSubscriptionId } = ids;
  if (!stripeCustomerId && !stripeSubscriptionId) return;
  await db.execute({
    sql: `UPDATE customers SET status = ?, updated_at = datetime('now')
          WHERE (stripe_subscription_id IS NOT NULL AND stripe_subscription_id = ?)
             OR (stripe_customer_id IS NOT NULL AND stripe_customer_id = ?)`,
    args: [status, stripeSubscriptionId, stripeCustomerId],
  });
}

async function handleCheckoutCompleted(db: ReturnType<typeof turso>, session: StripeObject): Promise<void> {
  const customerDetails = (session.customer_details as StripeObject | undefined) ?? {};
  const email = str(customerDetails, 'email') ?? str(session, 'customer_email');
  if (!email) {
    console.error('[stripe/webhook] checkout.session.completed with no email', str(session, 'id'));
    return;
  }
  const stripeCustomerId = str(session, 'customer');
  const stripeSubscriptionId = str(session, 'subscription');

  const existing = await db.execute({ sql: 'SELECT id, key FROM customers WHERE email = ?', args: [email] });
  let key: string;
  if (existing.rows.length > 0) {
    key = String(existing.rows[0].key);
    await db.execute({
      sql: `UPDATE customers SET status = 'active', stripe_customer_id = ?, stripe_subscription_id = ?,
            updated_at = datetime('now') WHERE email = ?`,
      args: [stripeCustomerId, stripeSubscriptionId, email],
    });
  } else {
    key = randomCustomerKey();
    await db.execute({
      sql: `INSERT INTO customers (email, key, status, stripe_customer_id, stripe_subscription_id)
            VALUES (?, ?, 'active', ?, ?)`,
      args: [email, key, stripeCustomerId, stripeSubscriptionId],
    });
  }

  // No transactional email wired yet (concierge MVP) — print so the link can be sent by hand.
  console.log(`[stripe/webhook] ACCESS LINK for ${email}: https://motivatedsignal.com/api/pro?key=${key}`);
}

export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }

  const signatureHeader = request.headers.get('stripe-signature');
  const rawBody = await request.text();
  if (!signatureHeader || !verifySignature(rawBody, signatureHeader, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }

  const db = turso();
  await ensureAccessSchema(db);

  try {
    const obj = event.data?.object ?? {};
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(db, obj);
        break;
      case 'customer.subscription.deleted':
        await setStatusByStripeIds(
          db,
          { stripeCustomerId: str(obj, 'customer'), stripeSubscriptionId: str(obj, 'id') },
          'canceled'
        );
        break;
      case 'invoice.payment_failed':
        await setStatusByStripeIds(
          db,
          { stripeCustomerId: str(obj, 'customer'), stripeSubscriptionId: str(obj, 'subscription') },
          'past_due'
        );
        break;
      case 'customer.subscription.updated': {
        const mapped = mapSubscriptionStatus(str(obj, 'status'));
        if (mapped) {
          await setStatusByStripeIds(
            db,
            { stripeCustomerId: str(obj, 'customer'), stripeSubscriptionId: str(obj, 'id') },
            mapped
          );
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('[stripe/webhook] handler error', event.type, err);
    return NextResponse.json({ error: 'handler error' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
