"use client";

import { useState, useEffect, useCallback } from "react";
import localFont from "next/font/local";
import s from "./ledger.module.css";
import DetailPanel from "./DetailPanel";

/* ── Fonts ───────────────────────────────────────────────── */
const fraunces = localFont({
  src: [
    { path: "../../fonts/Fraunces-Opsz-Normal.woff2", style: "normal" },
    { path: "../../fonts/Fraunces-Opsz-Italic.woff2", style: "italic" },
  ],
  weight: "100 900",
  variable: "--font-fraunces",
  display: "swap",
});

const ibmPlexMono = localFont({
  src: [
    { path: "../../fonts/IBMPlexMono-400.woff2", weight: "400", style: "normal" },
    { path: "../../fonts/IBMPlexMono-500.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

/* ── Types ───────────────────────────────────────────────── */
export interface Lead {
  apn: string;
  score: number;
  hot: boolean;
  signalTypes: string[];
  components: Record<string, number>;
  ownerName: string;
  situsAddress: string;
  situsCity: string;
  mailingAddress: string;
  absentee: boolean;
}

interface Summary {
  scored: number;
  hot: number;
  bySignal: {
    tax_delinquent: number;
    code_violation: number;
    trustee_sale: number;
    probate: number;
  };
  topCities: Array<{ city: string; n: number }>;
}

/* ── Constants ───────────────────────────────────────────── */
const SIGNAL_LABELS: Record<string, string> = {
  trustee_sale: "Trustee Sale",
  tax_delinquent: "Tax Delinquent",
  code_violation: "Code Violation",
  probate: "Probate",
};

const PILL_CLASS: Record<string, string> = {
  trustee_sale: s.pillTrusteeSale,
  tax_delinquent: s.pillTaxDelinquent,
  code_violation: s.pillCodeViolation,
  probate: s.pillProbate,
};

function scoreClass(score: number): string {
  if (score >= 80) return s.scoreVeryHigh;
  if (score >= 60) return s.scoreHigh;
  if (score >= 35) return s.scoreMid;
  return s.scoreLow;
}

/* ── Component ───────────────────────────────────────────── */
export default function LedgerPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Lead | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [leadsRes, summaryRes] = await Promise.all([
          fetch("/api/leads?limit=50"),
          fetch("/api/summary"),
        ]);

        if (!leadsRes.ok) throw new Error(`Leads fetch failed: ${leadsRes.status}`);
        if (!summaryRes.ok) throw new Error(`Summary fetch failed: ${summaryRes.status}`);

        const leadsData = await leadsRes.json();
        const summaryData = await summaryRes.json();

        setLeads(Array.isArray(leadsData) ? leadsData : (leadsData.leads ?? []));
        setSummary(summaryData);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load ledger");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const openDetail = useCallback((lead: Lead) => {
    setSelected(lead);
  }, []);

  const closeDetail = useCallback(() => {
    setSelected(null);
  }, []);

  function handleRowKeyDown(e: React.KeyboardEvent, lead: Lead) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDetail(lead);
    }
  }

  const fontVars = `${fraunces.variable} ${ibmPlexMono.variable}`;

  return (
    <div className={`${s.page} ${fontVars}`}>

      {/* ── Header ── */}
      <header className={s.header}>
        <div className={s.headerContent}>
          <h1 className={s.headline}>SUNBELT LEDGER</h1>
          <p className={s.subheadline}>
            This morning's list — Maricopa County
          </p>
          {summary && (
            <p className={s.statLine}>
              {summary.scored} motivated · {summary.hot} hot today
            </p>
          )}
        </div>
        <hr className={s.headerHairline} />
      </header>

      {/* ── Summary bar ── */}
      {summary && (
        <div className={s.summaryBar} role="region" aria-label="Summary statistics">
          <div className={s.summaryItem}>
            <span className={s.summaryLabel}>Trustee Sale</span>
            <span className={s.summaryValue}>{summary.bySignal.trustee_sale}</span>
          </div>
          <div className={s.summaryItem}>
            <span className={s.summaryLabel}>Tax Delinquent</span>
            <span className={s.summaryValue}>{summary.bySignal.tax_delinquent}</span>
          </div>
          <div className={s.summaryItem}>
            <span className={s.summaryLabel}>Code Violation</span>
            <span className={s.summaryValue}>{summary.bySignal.code_violation}</span>
          </div>
          <div className={s.summaryItem}>
            <span className={s.summaryLabel}>Probate</span>
            <span className={s.summaryValue}>{summary.bySignal.probate}</span>
          </div>
          {summary.topCities.slice(0, 3).map(({ city, n }) => (
            <div key={city} className={s.summaryItem}>
              <span className={s.summaryLabel}>{city}</span>
              <span className={s.summaryValue}>{n}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Ledger table ── */}
      {loading ? (
        <div className={s.stateWrap}>
          <p className={s.stateText}>Loading ledger…</p>
        </div>
      ) : error ? (
        <div className={s.stateWrap}>
          <p className={s.errorText}>{error}</p>
        </div>
      ) : (
        <div className={s.tableWrapper}>
          <table className={s.ledgerTable}>
            <thead>
              <tr>
                <th scope="col">Score</th>
                <th scope="col">Property</th>
                <th scope="col">City</th>
                <th scope="col">Owner</th>
                <th scope="col">Signals</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr
                  key={lead.apn}
                  className={lead.hot ? s.rowHot : undefined}
                  tabIndex={0}
                  role="button"
                  aria-label={`${lead.situsAddress}, score ${lead.score}. Press Enter to view details.`}
                  onClick={() => openDetail(lead)}
                  onKeyDown={(e) => handleRowKeyDown(e, lead)}
                >
                  <td className={s.cellScore}>
                    <span className={`${s.scoreValue} ${scoreClass(lead.score)}`}>
                      {lead.score}
                    </span>
                  </td>
                  <td className={s.cellProperty}>
                    <span className={s.propertyAddress}>{lead.situsAddress}</span>
                  </td>
                  <td>
                    <span className={s.cityValue}>{lead.situsCity}</span>
                  </td>
                  <td>
                    <div className={s.ownerCell}>
                      <span className={s.ownerName}>{lead.ownerName}</span>
                      {lead.absentee && (
                        <span className={s.absenteeBadge} title="Absentee owner">
                          A
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className={s.signalsCell}>
                      {lead.signalTypes.map((sig) => (
                        <span
                          key={sig}
                          className={`${s.signalPill} ${PILL_CLASS[sig] ?? s.pillProbate}`}
                        >
                          {SIGNAL_LABELS[sig] ?? sig}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {leads.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", padding: "2rem" }}>
                    <span className={s.stateText}>No leads found</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Detail panel ── */}
      {selected && (
        <DetailPanel lead={selected} onClose={closeDetail} />
      )}
    </div>
  );
}
