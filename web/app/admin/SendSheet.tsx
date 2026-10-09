'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import s from './admin.module.css';

export type SendSheetRowData = {
  id: number;
  rank: number;
  company: string;
  contactName: string | null;
  segment: string | null;
  email: string | null;
  phone: string | null;
  url: string | null;
  status: string;
  variant: string | null;
  subjects: Record<'A' | 'B' | 'C' | 'D', string>;
  body: string;
  reply: string;
  pixel: string;
  matchDate: string | null;
  matches: { pitchLine: string; matchTier: string | null }[] | null;
  inboxFlag: 'shared' | 'third-party' | null;
};

async function copy(text: string, setCopied: (v: string | null) => void, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  } catch {
    setCopied('copy failed');
    setTimeout(() => setCopied(null), 1500);
  }
}

function Row({ row, campaignId, adminKey }: { row: SendSheetRowData; campaignId: number; adminKey: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(row.status);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const variant = row.variant ?? 'A';
  const subject = row.subjects[variant as 'A' | 'B' | 'C' | 'D'];

  async function mark(event: 'sent' | 'replied' | 'stop') {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ prospect_id: row.id, campaign_id: campaignId, event }),
      });
      if (res.ok) {
        if (event === 'stop') setStatus('stop');
        else if (event === 'replied' && !['trial', 'paid', 'stop'].includes(status)) setStatus('replied');
        else if (event === 'sent' && status === 'new') setStatus('sent');
        router.refresh();
      } else {
        setCopied('action failed');
        setTimeout(() => setCopied(null), 1500);
      }
    } catch {
      setCopied('action failed');
      setTimeout(() => setCopied(null), 1500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={s.sheetRow}>
      <button type="button" className={s.sheetHead} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={s.sheetRank}>#{row.rank}</span>
        <span className={s.sheetCompany}>{row.company}</span>
        <span className={s.dim}>{row.contactName ?? '—'}</span>
        {row.segment && <span className={s.segment}>{row.segment}</span>}
        <span className={s.segment}>{status}</span>
        {row.variant && <span className={s.segment}>variant {row.variant}</span>}
        {row.inboxFlag === 'shared' && <span className={s.badgeFlag}>shared inbox</span>}
        {row.inboxFlag === 'third-party' && <span className={s.badgeFlag}>third-party</span>}
        <span className={s.sheetChevron} aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className={s.sheetBody}>
          <div className={s.emailField}>
            <p className={s.emailLabel}>Subject lines (variant {variant} is assigned to this prospect)</p>
            <ul className={s.variantList}>
              {(['A', 'B', 'C', 'D'] as const).map((v) => (
                <li key={v} className={v === variant ? s.variantActive : undefined}>
                  <span className={s.mono}>{v}</span> {row.subjects[v]}
                </li>
              ))}
            </ul>
          </div>

          {row.matches && row.matches.length > 0 && (
            <div className={s.emailField}>
              <p className={s.emailLabel}>Matched leads in touch 1 ({row.matchDate})</p>
              <ul className={s.variantList}>
                {row.matches.map((m, i) => (
                  <li key={i}>
                    <span className={s.segment}>{m.matchTier ?? 'any'}</span> {m.pitchLine}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className={s.emailField}>
            <p className={s.emailLabel}>Body</p>
            <pre className={s.emailText}>{row.body}</pre>
          </div>

          <div className={s.emailField}>
            <p className={s.emailLabel}>Reply to &quot;send it&quot;</p>
            <pre className={s.emailText}>{row.reply}</pre>
          </div>

          <div className={s.emailField}>
            <p className={s.emailLabel}>Tracking pixel (optional)</p>
            <pre className={s.emailTextSmall}>{row.pixel}</pre>
            <p className={s.noteSmall}>
              Only fires if the email is sent as HTML, and Apple Mail Privacy Protection auto-loads it for
              every recipient regardless of real opens. Default to plain text, no pixel.
            </p>
          </div>

          <div className={s.sheetActions}>
            <button type="button" className={s.btn} onClick={() => copy(subject, setCopied, 'subject copied')}>
              Copy subject
            </button>
            <button type="button" className={s.btn} onClick={() => copy(row.body, setCopied, 'body copied')}>
              Copy body
            </button>
            <button type="button" className={s.btnGhost} disabled={busy} onClick={() => mark('sent')}>
              Mark sent
            </button>
            <button type="button" className={s.btnGhost} disabled={busy} onClick={() => mark('replied')}>
              Mark replied
            </button>
            <button type="button" className={s.btnDanger} disabled={busy} onClick={() => mark('stop')}>
              Stop
            </button>
            {copied && <span className={s.dim}>{copied}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

export default function SendSheet({
  rows,
  campaignId,
  adminKey,
}: {
  rows: SendSheetRowData[];
  campaignId: number;
  adminKey: string;
}) {
  if (rows.length === 0) {
    return <p className={s.dim}>No prospects match this filter.</p>;
  }
  return (
    <ul className={s.sheetList}>
      {rows.map((row) => (
        <Row key={row.id} row={row} campaignId={campaignId} adminKey={adminKey} />
      ))}
    </ul>
  );
}
