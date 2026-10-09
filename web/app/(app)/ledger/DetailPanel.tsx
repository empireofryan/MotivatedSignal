"use client";

import { useEffect, useRef } from "react";
import s from "./ledger.module.css";
import type { Lead } from "./page";

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

interface Props {
  lead: Lead;
  onClose: () => void;
}

export default function DetailPanel({ lead, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  /* Focus the close button when panel opens */
  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  /* Escape key */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* Trap focus inside panel */
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = panel!.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    panel.addEventListener("keydown", onKey);
    return () => panel.removeEventListener("keydown", onKey);
  }, []);

  const componentEntries = Object.entries(lead.components).sort(
    ([, a], [, b]) => b - a
  );
  const maxComponent = Math.max(...componentEntries.map(([, v]) => v), 1);

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-label="Property detail">
      {/* Backdrop */}
      <div
        className={s.overlayBackdrop}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className={s.detailPanel} ref={panelRef}>
        {/* Header */}
        <div className={s.detailHeader}>
          <p className={s.detailAddress}>{lead.situsAddress}</p>
          <button
            ref={closeBtnRef}
            className={s.closeBtn}
            onClick={onClose}
            aria-label="Close detail panel"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className={s.detailBody}>

          {/* Ownership */}
          <section className={s.detailSection}>
            <h2 className={s.detailSectionTitle}>Ownership</h2>
            <div className={s.detailRow}>
              <span className={s.detailLabel}>Owner</span>
              <span className={s.detailValue}>{lead.ownerName}</span>
            </div>
            <div className={s.detailRow}>
              <span className={s.detailLabel}>Mailing address</span>
              <span className={s.detailValue}>{lead.mailingAddress}</span>
            </div>
            <div className={s.detailRow}>
              <span className={s.detailLabel}>Absentee owner</span>
              <span className={lead.absentee ? s.detailValueAccent : s.detailValue}>
                {lead.absentee ? "Yes" : "No"}
              </span>
            </div>
            <div className={s.detailRow}>
              <span className={s.detailLabel}>City</span>
              <span className={s.detailValue}>{lead.situsCity}</span>
            </div>
            <div className={s.detailRow}>
              <span className={s.detailLabel}>APN</span>
              <span className={s.detailValue}>{lead.apn}</span>
            </div>
          </section>

          {/* Score */}
          <section className={s.detailSection}>
            <h2 className={s.detailSectionTitle}>Score</h2>
            <div className={s.detailRow}>
              <span className={s.detailLabel}>Total score</span>
              <span className={s.detailValueAccent}>{lead.score}</span>
            </div>
            <div className={s.detailRow}>
              <span className={s.detailLabel}>Hot today</span>
              <span className={lead.hot ? s.detailValueAccent : s.detailValue}>
                {lead.hot ? "Yes" : "No"}
              </span>
            </div>
          </section>

          {/* Signals */}
          <section className={s.detailSection}>
            <h2 className={s.detailSectionTitle}>Signals</h2>
            <div className={s.detailSignals}>
              {lead.signalTypes.map((sig) => (
                <span
                  key={sig}
                  className={`${s.signalPill} ${PILL_CLASS[sig] ?? s.pillProbate}`}
                >
                  {SIGNAL_LABELS[sig] ?? sig}
                </span>
              ))}
              {lead.signalTypes.length === 0 && (
                <span className={s.detailLabel}>None</span>
              )}
            </div>
          </section>

          {/* Components breakdown */}
          <section className={s.detailSection}>
            <h2 className={s.detailSectionTitle}>Why it scored</h2>
            {componentEntries.length === 0 && (
              <span className={s.detailLabel}>No breakdown available</span>
            )}
            {componentEntries.map(([key, value]) => (
              <div key={key} className={s.componentRow}>
                <span className={s.componentLabel}>
                  {key.replace(/_/g, " ")}
                </span>
                <div className={s.componentBar}>
                  <div className={s.componentBarTrack}>
                    <div
                      className={s.componentBarFill}
                      style={{ width: `${(value / maxComponent) * 100}%` }}
                    />
                  </div>
                </div>
                <span className={s.componentValue}>+{value}</span>
              </div>
            ))}
          </section>

        </div>
      </div>
    </div>
  );
}
