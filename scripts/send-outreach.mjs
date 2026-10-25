#!/usr/bin/env node
// Automated cold-email sender (GitHub Actions: .github/workflows/send-outreach.yml).
// Plain-text only, no tracking pixel. Logs prospect id + recipient DOMAIN only: Actions logs on
// this public repo are public, so never print full addresses, names, or bodies.
//
// Env: ADMIN_KEY (required), ZOHO_SMTP_PASS, SEND_N (override; empty = server ramp), DRY_RUN, TEST_TO.

import nodemailer from 'nodemailer';
import {
  classifySmtpError, randomDelayMs, domainOf, isTruthy, parseSendN, MAX_CONSECUTIVE_BOUNCES,
} from './send-lib.mjs';

const SITE = process.env.SITE_URL || 'https://motivatedsignal.com';
const FROM = 'Ryan at MotivatedSignal <hello@motivatedsignal.com>';
const REPLY_TO = 'hello@motivatedsignal.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${SITE}${path}`, {
    method,
    headers: { 'x-admin-key': process.env.ADMIN_KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> HTTP ${res.status}`);
  return res.json();
}

async function postEvent(item, event) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      await api('/api/admin/event', {
        method: 'POST',
        body: { prospect_id: item.prospect_id, campaign_id: item.campaign_id, event },
      });
      return;
    } catch (err) {
      lastErr = err;
      await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

async function main() {
  if (!process.env.ADMIN_KEY) {
    console.error('ADMIN_KEY not set, nothing to do');
    process.exit(1);
  }
  const dryRun = isTruthy(process.env.DRY_RUN);
  const testTo = (process.env.TEST_TO || '').trim();
  const override = parseSendN(process.env.SEND_N);
  const havePass = Boolean(process.env.ZOHO_SMTP_PASS);

  if (!havePass) {
    console.log('ZOHO_SMTP_PASS not set');
    if (!dryRun) {
      console.log('Nothing sent.');
      return;
    }
  }

  if (testTo) {
    if (!havePass) return;
    const [item] = await api('/api/admin/next-batch?n=1');
    if (!item) return console.log('no prospect available to render a test email');
    const transport = makeTransport();
    await transport.sendMail({
      from: FROM, replyTo: REPLY_TO, to: testTo, subject: `[TEST] ${item.subject}`, text: item.body,
    });
    console.log(`test email sent (rendered from prospect ${item.prospect_id}, variant ${item.variant}); nothing marked`);
    return;
  }

  const status = await api(`/api/admin/pipeline-status${override ? `?n=${override}` : ''}`);
  console.log(
    `status: phoenix=${status.phoenix_date} pipeline_ran=${status.pipeline_ran_today} send_days=${status.send_days} ` +
      `sent_today=${status.sent_today} target=${status.target} remaining=${status.remaining}`
  );
  if (!status.pipeline_ran_today) {
    console.log('pipeline has not run today, not sending');
    return;
  }
  if (status.halt) {
    console.error(`!!! HALT: ${status.halt_reason}. Sending nothing. Review /admin, then clear the cause. !!!`);
    process.exit(1);
  }
  if (status.remaining <= 0) {
    console.log('daily target/cap already reached, nothing to send');
    return;
  }

  const batch = await api(`/api/admin/next-batch?n=${status.remaining}`);
  console.log(`selected ${batch.length} prospect(s)`);

  if (dryRun) {
    for (const it of batch) {
      console.log(`DRY RUN prospect=${it.prospect_id} variant=${it.variant} domain=${domainOf(it.to)} subject="${it.subject}"`);
    }
    console.log('dry run: no email sent, no events written');
    return;
  }
  if (batch.length === 0) return;

  const transport = makeTransport();
  let sent = 0;
  let bounced = 0;
  let consecutiveBounces = 0;
  for (let i = 0; i < batch.length; i++) {
    const it = batch[i];
    if (i > 0) await sleep(randomDelayMs());
    try {
      await transport.sendMail({
        from: FROM, replyTo: REPLY_TO,
        to: it.to_name ? { name: it.to_name, address: it.to } : it.to,
        subject: it.subject, text: it.body,
      });
    } catch (err) {
      const kind = classifySmtpError(err);
      const info = `code=${err.code ?? '-'} smtp=${err.responseCode ?? '-'}`;
      if (kind === 'bounce') {
        console.log(`BOUNCE prospect=${it.prospect_id} domain=${domainOf(it.to)} ${info}`);
        await postEvent(it, 'bounced');
        bounced++;
        if (++consecutiveBounces >= MAX_CONSECUTIVE_BOUNCES) {
          console.error(`!!! ${consecutiveBounces} bounces in a row, aborting batch !!!`);
          process.exit(1);
        }
        continue;
      }
      console.error(`ABORT at prospect=${it.prospect_id} ${info}`);
      process.exit(1);
    }
    consecutiveBounces = 0;
    // The mail is out; if recording fails we must stop, or the next run would re-send it.
    try {
      await postEvent(it, 'sent');
    } catch {
      console.error(`!!! sent prospect=${it.prospect_id} but could not record the event; aborting so it is not re-sent. Record it by hand in /admin. !!!`);
      process.exit(1);
    }
    sent++;
    console.log(`sent prospect=${it.prospect_id} variant=${it.variant} domain=${domainOf(it.to)}`);
  }
  console.log(`done: sent=${sent} bounced=${bounced}`);
}

function makeTransport() {
  return nodemailer.createTransport({
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    auth: { user: 'hello@motivatedsignal.com', pass: process.env.ZOHO_SMTP_PASS },
  });
}

main().catch((err) => {
  // Error messages here are HTTP status lines or SMTP codes; never include addresses.
  console.error(`send-outreach failed: ${err && err.message ? err.message : 'unknown error'}`);
  process.exit(1);
});
