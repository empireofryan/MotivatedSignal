'use client';

// "Who engaged" — one row per prospect with any tracked click or page_events activity, newest
// first (web/app/admin/page.tsx's getEngagement()). Data comes from outreach_events (event =
// 'clicked', meta = {userAgent, bot}, written by web/app/r/[code]/route.ts) and page_events
// (written by POST /api/track, attributed to a prospect via the signed `ms_pid` cookie).

import { useState } from 'react';
import s from './admin.module.css';

export type EngagementTimelineEntry = {
  at: string;
  kind: 'click' | 'page';
  event: string;
  path: string | null;
  bot: boolean | null;
};

export type EngagedRow = {
  prospectId: number;
  company: string;
  contactName: string | null;
  segment: string | null;
  variant: string | null;
  firstClickAt: string | null;
  lastSeen: string;
  humanClicks: number;
  botClicks: number;
  sessions: number;
  engagedMsOnReport: number;
  pagesVisited: string[];
  rowsExpanded: number;
  exportClicks: number;
  ctaClicks: number;
  timeline: EngagementTimelineEntry[];
};

const PHOENIX_TZ = 'America/Phoenix';

// Turso's `datetime('now')` values are UTC without a trailing 'Z' (e.g. "2026-10-05 14:32:10") —
// normalize to ISO before parsing so this doesn't get interpreted as local time.
function phoenixLabel(iso: string | null): string {
  if (!iso) return '—';
  const t = iso.includes('T') ? iso : iso.replace(' ', 'T');
  const d = new Date(t.endsWith('Z') ? t : `${t}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: PHOENIX_TZ,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function formatMs(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function Row({ row }: { row: EngagedRow }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={s.sheetRow}>
      <button type="button" className={s.sheetHead} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={s.sheetCompany}>{row.company}</span>
        <span className={s.dim}>{row.contactName ?? '—'}</span>
        {row.segment && <span className={s.segment}>{row.segment}</span>}
        {row.variant && <span className={s.segment}>variant {row.variant}</span>}
        <span className={s.mono}>
          {row.humanClicks} click{row.humanClicks === 1 ? '' : 's'}
        </span>
        {row.botClicks > 0 && <span className={s.dim}>{row.botClicks} bot</span>}
        <span className={s.mono}>
          {row.sessions} session{row.sessions === 1 ? '' : 's'}
        </span>
        <span className={s.mono}>{formatMs(row.engagedMsOnReport)} on /report</span>
        <span className={s.dim}>last seen {phoenixLabel(row.lastSeen)}</span>
        <span className={s.sheetChevron} aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className={s.sheetBody}>
          <div className={s.emailField}>
            <p className={s.emailLabel}>First click (Phoenix)</p>
            <p className={s.mono}>{phoenixLabel(row.firstClickAt)}</p>
          </div>
          <div className={s.emailField}>
            <p className={s.emailLabel}>Pages visited</p>
            <p className={s.mono}>{row.pagesVisited.length > 0 ? row.pagesVisited.join(', ') : '—'}</p>
          </div>
          <div className={s.emailField}>
            <p className={s.emailLabel}>Rows expanded / Export clicks / CTA clicks</p>
            <p className={s.mono}>
              {row.rowsExpanded} / {row.exportClicks} / {row.ctaClicks}
            </p>
          </div>
          <div className={s.emailField}>
            <p className={s.emailLabel}>Event timeline</p>
            <ul className={s.variantList}>
              {row.timeline.map((e, i) => (
                <li key={i}>
                  <span className={s.mono}>{phoenixLabel(e.at)}</span>{' '}
                  {e.kind === 'click' ? (
                    <span className={s.segment}>{e.bot ? 'bot click' : 'click'}</span>
                  ) : (
                    <span className={s.segment}>{e.event}</span>
                  )}
                  {e.path && <span className={s.dim}> {e.path}</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  );
}

export default function WhoEngaged({ rows }: { rows: EngagedRow[] }) {
  if (rows.length === 0) {
    return <p className={s.dim}>No clicks or page activity yet.</p>;
  }
  return (
    <ul className={s.sheetList}>
      {rows.map((row) => (
        <Row key={row.prospectId} row={row} />
      ))}
    </ul>
  );
}
