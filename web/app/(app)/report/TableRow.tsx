'use client';

import { useId, useState } from 'react';
import type { ReportRow } from '../../../lib/report';
import { track } from '../../../components/Tracker';
import {
  SIGNAL_LABELS,
  URGENT,
  titleCase,
  formatSitusAddress,
  fmtDate,
  fmtDatePhoenix,
  fmtDateTimePhoenix,
  fmtMoney,
  fmtAuction,
  provenanceVerb,
} from './format';
import s from './report.module.css';

// One report row, plus its collapsed-by-default provenance panel. A client
// component (not the server page) only because the disclosure needs state —
// every value it renders was already computed server-side in page.tsx and
// handed down as plain props on `row`.
export default function TableRow({
  row,
  rank,
  maxScore,
  isPro,
}: {
  row: ReportRow;
  rank: number;
  maxScore: number;
  isPro: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const r = row;
  const types = (r.signal_types ?? r.signal_type).split(',').map((t) => t.trim()).filter(Boolean);
  const score = Number(r.score ?? 0);
  const pct = Math.max(6, Math.min(100, (score / maxScore) * 100));
  // amber (40°) at the low end → red (8°) at the top
  const hue = Math.round(40 - 32 * (pct / 100));
  const auction = r.est_auction_date ? fmtAuction(r.est_auction_date) : null;
  const signals = r.signals ?? [];

  return (
    <>
      <tr className={r.is_hot ? s.rowHot : undefined}>
        <td className={s.rank}>
          <button
            type="button"
            className={s.expandBtn}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => {
              track('report_row_expand', { apn: r.apn, rank, open: !open });
              setOpen((v) => !v);
            }}
          >
            <span>{rank}</span>
            <span className={s.expandChevron} aria-hidden="true">{open ? '▾' : '▸'}</span>
            <span className={s.srOnly}>{open ? 'Hide' : 'Show'} where this came from</span>
          </button>
        </td>
        <td className={s.scoreCell}>
          {r.score != null ? (
            <span className={s.heat} style={{ ['--w' as string]: `${pct}%`, ['--h' as string]: hue }}>
              <span className={s.heatNum}>{score}</span>
              <span className={s.heatTrack}><span className={s.heatFill} /></span>
            </span>
          ) : (
            <span className={s.dim}>-</span>
          )}
        </td>
        <td className={s.property}>
          {r.situs_address ? (
            <>
              <span className={s.addr}>{titleCase(formatSitusAddress(r.situs_address))}</span>
              <span className={s.sub}>
                {r.situs_city ? titleCase(r.situs_city) : ''}
                {r.absentee === true ? (
                  <>
                    {' '}<span className={s.abs}>Absentee</span>
                    {r.mailing_address
                      ? isPro
                        ? ` mails to ${titleCase(r.mailing_address)}`
                        : ' mailing address in Pro'
                      : ''}
                  </>
                ) : r.absentee === false ? ', owner-occupied' : ''}
              </span>
            </>
          ) : r.apn ? (
            <>
              <span className={s.dim}>No situs address on file</span>
              {r.mailing_address ? (
                <span className={s.sub}>
                  {isPro ? `Mails to ${titleCase(r.mailing_address)}` : 'Mailing address in Pro'}
                </span>
              ) : null}
            </>
          ) : (
            <span className={s.dim}>Address not yet matched</span>
          )}
        </td>
        <td className={s.owner}>
          {r.owner_name ? titleCase(r.owner_name) : <span className={s.dim}>-</span>}
          {r.is_entity ? <span className={s.tagEntity}>Entity</span> : null}
        </td>
        <td className={s.signals}>
          {types.map((t) => (
            <span key={t} className={`${s.tag} ${URGENT.has(t) ? s.tagUrgent : ''}`}>
              {SIGNAL_LABELS[t] ?? t}
            </span>
          ))}
        </td>
        <td className={`${s.num} ${s.mono}`}>
          {r.event_date ? (
            <>
              {fmtDate(r.event_date)}
              {r.first_seen ? <span className={s.subNum}>in report {fmtDatePhoenix(r.first_seen)}</span> : null}
            </>
          ) : (
            <span className={s.dim}>-</span>
          )}
        </td>
        <td className={`${s.num} ${s.mono}`}>
          {auction ? (
            <>
              {auction.dateStr} (est.)
              <span className={s.subNum}>{auction.rel}</span>
            </>
          ) : (
            <span className={s.dim}>-</span>
          )}
        </td>
        <td className={`${s.num} ${s.mono}`}>
          {r.assessed_value != null ? fmtMoney(r.assessed_value) : <span className={s.dim}>-</span>}
        </td>
        <td className={`${s.num} ${s.mono}`}>
          {r.years_owned != null ? (
            <>
              {r.years_owned} yr{r.years_owned === 1 ? '' : 's'}
              {r.last_sale_price != null ? <span className={s.subNum}>paid {fmtMoney(r.last_sale_price)}</span> : null}
            </>
          ) : (
            <span className={s.dim}>-</span>
          )}
        </td>
      </tr>
      {open ? (
        <tr className={s.expandRow}>
          <td className={s.expandSpacer} aria-hidden="true" />
          <td colSpan={8} id={panelId}>
            <div className={s.provenancePanel}>
              {signals.length === 0 ? (
                <p className={s.provenanceEmpty}>No signal detail on file for this parcel.</p>
              ) : (
                <ul className={s.provenanceList}>
                  {signals.map((sig, i) => (
                    <li key={`${sig.source}-${sig.external_id}-${i}`} className={s.provenanceItem}>
                      <span className={s.provType}>{SIGNAL_LABELS[sig.type] ?? sig.type}</span>
                      <span className={s.provVerb}>
                        {provenanceVerb(sig.type)} {sig.event_date ? fmtDate(sig.event_date) : 'date unknown'}
                      </span>
                      <span className={s.provSeen}>In report {fmtDateTimePhoenix(sig.first_seen)}</span>
                      <span className={s.provId}>{sig.external_id}</span>
                      {sig.source_url ? (
                        <a className={s.provLink} href={sig.source_url} target="_blank" rel="noopener noreferrer">
                          View source &#8599;
                        </a>
                      ) : (
                        <span className={s.provNoLink}>No public link</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
