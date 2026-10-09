'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import localFont from 'next/font/local';
import styles from './condemned.module.css';

const stardos = localFont({
  src: '../../fonts/StardosStencil-700.woff2',
  weight: '700',
  style: 'normal',
  variable: '--font-stardos',
});

const ibmMono = localFont({
  src: [
    { path: '../../fonts/IBMPlexMono-400.woff2', weight: '400', style: 'normal' },
    { path: '../../fonts/IBMPlexMono-500.woff2', weight: '500', style: 'normal' },
  ],
  variable: '--font-ibm-mono',
});

// ---- Types ----

type Lead = {
  apn: string;
  score: number;
  hot: boolean;
  signalTypes: string[];
  components: Record<string, unknown>;
  ownerName: string | null;
  situsAddress: string | null;
  situsCity: string | null;
  mailingAddress: string | null;
  absentee: boolean;
};

type Summary = {
  scored: number;
  hot: number;
  bySignal: {
    tax_delinquent?: number;
    code_violation?: number;
    trustee_sale?: number;
    probate?: number;
  };
  topCities: Array<{ city: string; n: number }>;
};

// ---- Helpers ----

const SIGNAL_LABELS: Record<string, string> = {
  trustee_sale: 'Trustee Sale',
  tax_delinquent: 'Tax Delinquent',
  code_violation: 'Code Violation',
  probate: 'Probate',
};

const SIGNAL_COLORS: Record<string, 'red' | 'amber'> = {
  trustee_sale: 'red',
  tax_delinquent: 'red',
  code_violation: 'amber',
  probate: 'amber',
};

/** Derive a deterministic "posted date" from the APN.
 *  Uses the last 4 numeric chars as a day offset from 2024-01-01. */
function getPostedDate(apn: string): string {
  const digits = apn.replace(/\D/g, '');
  const lastFour = parseInt(digits.slice(-4) || '0', 10);
  const base = new Date('2024-01-01T00:00:00Z');
  base.setUTCDate(base.getUTCDate() + (lastFour % 730)); // cap at ~2 years
  return base.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// ---- Sub-components ----

interface NoticeCardProps {
  lead: Lead;
  onClick: () => void;
}

function NoticeCard({ lead, onClick }: NoticeCardProps) {
  const postedDate = getPostedDate(lead.apn);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  }

  return (
    <div
      className={styles.card}
      role="button"
      tabIndex={0}
      aria-label={`View notice for ${lead.situsAddress ?? lead.apn}`}
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      <span className={styles.exhibitTab}>EXHIBIT</span>

      {lead.hot && (
        <div className={styles.hotBand} aria-label="Active hot lead">
          <span className={styles.hotBandText}>ACTIVE / HOT</span>
        </div>
      )}

      <div className={styles.cardBody}>
        <div className={styles.cardHeader}>Notice of Motivation</div>

        <div className={styles.caseNumber}>CASE № {lead.apn}</div>

        <div className={styles.cardAddress}>
          {lead.situsAddress ?? 'ADDRESS UNKNOWN'}
        </div>
        <div className={styles.cardCity}>
          {lead.situsCity ?? 'CITY UNKNOWN'} · MARICOPA CO.
        </div>

        <div className={styles.postedDate}>POSTED: {postedDate}</div>

        {lead.signalTypes.length > 0 && (
          <div className={styles.signals}>
            {lead.signalTypes.map((sig) => {
              const color = SIGNAL_COLORS[sig] ?? 'amber';
              return (
                <span
                  key={sig}
                  className={
                    color === 'red'
                      ? `${styles.signalTag} ${styles.signalTagRed}`
                      : `${styles.signalTag} ${styles.signalTagAmber}`
                  }
                >
                  {SIGNAL_LABELS[sig] ?? sig}
                </span>
              );
            })}
          </div>
        )}

        <div className={styles.scoreRow}>
          <div className={styles.scoreLabel}>
            <span>PRIORITY SCORE</span>
            <span className={styles.scoreValue}>{lead.score}/100</span>
          </div>
          <div className={styles.scoreBar}>
            <div
              className={
                lead.hot
                  ? `${styles.scoreBarFill} ${styles.scoreBarFillHot}`
                  : styles.scoreBarFill
              }
              style={{ width: `${lead.score ?? 0}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Modal ----

interface ModalProps {
  lead: Lead;
  onClose: () => void;
}

function NoticeModal({ lead, onClose }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const postedDate = getPostedDate(lead.apn);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleFocusTrap = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    ).filter(el => !el.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') onClose();
    handleFocusTrap(e);
  }

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  const componentEntries = Object.entries(lead.components).filter(
    ([, v]) => v !== null && v !== undefined && v !== 0 && v !== false
  );

  return (
    <div
      className={styles.modalOverlay}
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className={styles.modal}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Property notice detail"
      >
        <div className={styles.modalHazardBand} />

        <div className={styles.modalBody}>
          {/* Watermark stamp */}
          <div className={styles.stamp} aria-hidden="true">
            CONDEMNED
          </div>

          <div className={styles.modalOfficialHeader}>
            OFFICIAL NOTICE — DEPT. OF MOTIVATED SELLERS
          </div>
          <div className={styles.modalTitle}>
            {lead.situsAddress ?? 'ADDRESS OF RECORD UNKNOWN'}
          </div>
          <div className={styles.modalCity}>
            {lead.situsCity ?? 'CITY UNKNOWN'} · MARICOPA COUNTY
          </div>

          <hr className={styles.modalDivider} />

          <div className={styles.modalSection}>
            <div className={styles.modalSectionLabel}>CASE FILED</div>
            <div className={styles.modalSectionValue}>{postedDate}</div>
          </div>

          <div className={styles.modalSection}>
            <div className={styles.modalSectionLabel}>CASE №</div>
            <div className={styles.modalSectionValue}>{lead.apn}</div>
          </div>

          <div className={styles.modalSection}>
            <div className={styles.modalSectionLabel}>OWNER ON FILE</div>
            <div className={styles.modalSectionValue}>
              {lead.ownerName ?? 'OWNER UNKNOWN'}
            </div>
          </div>

          {lead.mailingAddress && (
            <div className={styles.modalSection}>
              <div className={styles.modalSectionLabel}>MAILING OF RECORD</div>
              <div className={styles.modalSectionValue}>
                {lead.mailingAddress}
              </div>
            </div>
          )}

          <div className={styles.modalSection}>
            <div className={styles.modalSectionLabel}>OCCUPANCY STATUS</div>
            <div className={styles.modalSectionValue}>
              <span
                className={
                  lead.absentee
                    ? `${styles.modalAbsenteeBadge} ${styles.modalAbsenteeBadgeYes}`
                    : `${styles.modalAbsenteeBadge} ${styles.modalAbsenteeBadgeNo}`
                }
              >
                {lead.absentee
                  ? 'ABSENTEE OWNER — NOT IN RESIDENCE'
                  : 'OWNER-OCCUPIED'}
              </span>
            </div>
          </div>

          <hr className={styles.modalDivider} />

          <div className={styles.modalSection}>
            <div className={styles.modalSectionLabel}>
              SIGNALS DETECTED ({lead.signalTypes.length})
            </div>
            <div className={styles.signals} style={{ marginTop: '0.4rem' }}>
              {lead.signalTypes.map((sig) => {
                const color = SIGNAL_COLORS[sig] ?? 'amber';
                return (
                  <span
                    key={sig}
                    className={
                      color === 'red'
                        ? `${styles.signalTag} ${styles.signalTagRed}`
                        : `${styles.signalTag} ${styles.signalTagAmber}`
                    }
                  >
                    {SIGNAL_LABELS[sig] ?? sig}
                  </span>
                );
              })}
            </div>
          </div>

          {componentEntries.length > 0 && (
            <div className={styles.modalSection}>
              <div className={styles.modalSectionLabel}>
                SIGNAL BREAKDOWN — COMPONENTS
              </div>
              <div className={styles.componentsList}>
                {componentEntries.map(([key, val]) => (
                  <div key={key} className={styles.componentRow}>
                    <span className={styles.componentKey}>
                      {key.replace(/_/g, ' ')}
                    </span>
                    <span className={styles.componentVal}>
                      {String(val)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={styles.modalSection}>
            <div className={styles.modalSectionLabel}>PRIORITY SCORE</div>
            <div className={styles.scoreRow}>
              <div className={styles.scoreLabel}>
                <span></span>
                <span className={styles.scoreValue}>{lead.score}/100</span>
              </div>
              <div className={styles.scoreBar}>
                <div
                  className={
                    lead.hot
                      ? `${styles.scoreBarFill} ${styles.scoreBarFillHot}`
                      : styles.scoreBarFill
                  }
                  style={{ width: `${lead.score ?? 0}%` }}
                />
              </div>
            </div>
          </div>

          <button
            className={styles.dismissBtn}
            onClick={onClose}
            type="button"
          >
            DISMISS NOTICE
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Page ----

export default function CondemnedPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const [leadsRes, summaryRes] = await Promise.all([
          fetch('/api/leads?limit=50'),
          fetch('/api/summary'),
        ]);

        if (!leadsRes.ok || !summaryRes.ok) {
          throw new Error(
            `HTTP ${leadsRes.ok ? summaryRes.status : leadsRes.status}`
          );
        }

        const [leadsData, summaryData] = await Promise.all([
          leadsRes.json() as Promise<Lead[]>,
          summaryRes.json() as Promise<Summary>,
        ]);

        setLeads(leadsData);
        setSummary(summaryData);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    void fetchData();
  }, []);

  const handleClose = useCallback(() => setSelectedLead(null), []);

  // Global Escape key handler when modal is open
  useEffect(() => {
    if (!selectedLead) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedLead, handleClose]);

  const rootClass = `${stardos.variable} ${ibmMono.variable} ${styles.page}`;

  return (
    <div className={rootClass}>
      {/* ---- Header ---- */}
      <header className={styles.header}>
        <div className={styles.headerHazardBand} />
        <div className={styles.headerCorner} />

        <h1 className={styles.headerTitle}>
          Notice Board · Maricopa County
        </h1>
        <p className={styles.headerSubtitle}>
          Department of Motivated Sellers — Case Management System
        </p>

        {summary && (
          <>
            <div className={styles.statBar}>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Cases Scored</span>
                <span className={styles.statValue}>{summary.scored}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Hot Cases</span>
                <span className={`${styles.statValue} ${styles.statValueHot}`}>
                  {summary.hot}
                </span>
              </div>
              {summary.bySignal.tax_delinquent !== undefined && (
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Tax Delinquent</span>
                  <span className={styles.statValue}>
                    {summary.bySignal.tax_delinquent}
                  </span>
                </div>
              )}
              {summary.bySignal.code_violation !== undefined && (
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Code Violations</span>
                  <span className={styles.statValue}>
                    {summary.bySignal.code_violation}
                  </span>
                </div>
              )}
              {summary.bySignal.trustee_sale !== undefined && (
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Trustee Sales</span>
                  <span className={styles.statValue}>
                    {summary.bySignal.trustee_sale}
                  </span>
                </div>
              )}
              {summary.bySignal.probate !== undefined && (
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Probate</span>
                  <span className={styles.statValue}>
                    {summary.bySignal.probate}
                  </span>
                </div>
              )}
            </div>

            {summary.topCities.length > 0 && (
              <div className={styles.cityTags}>
                {summary.topCities.map(({ city, n }) => (
                  <span key={city} className={styles.cityTag}>
                    {city} · {n}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </header>

      {/* ---- Main Content ---- */}
      <main className={styles.main}>
        {loading && (
          <div className={styles.stateContainer}>
            <div
              className={`${styles.stateTitle} ${styles.statePulse}`}
            >
              Retrieving Case Files…
            </div>
            <div className={styles.stateSubtitle}>
              Accessing county records database
            </div>
            {/* Skeleton grid */}
            <div className={styles.grid} style={{ width: '100%', marginTop: '2rem' }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={styles.skeletonCard} />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className={styles.stateContainer}>
            <div className={styles.errorBorder}>
              <div className={styles.stateTitle}>Records Unavailable</div>
              <div className={styles.stateSubtitle} style={{ marginTop: '0.5rem' }}>
                DATABASE CONNECTION FAILED — {error}
              </div>
            </div>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className={styles.sectionLabel}>
              Active Case Files — {leads.length} notices on file
            </div>

            <div className={styles.grid}>
              {leads.map((lead) => (
                <NoticeCard
                  key={lead.apn}
                  lead={lead}
                  onClick={() => setSelectedLead(lead)}
                />
              ))}
            </div>

            {leads.length === 0 && (
              <div className={styles.stateContainer}>
                <div className={styles.stateTitle}>No Cases on File</div>
                <div className={styles.stateSubtitle}>
                  Case management system shows no active notices
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* ---- Modal ---- */}
      {selectedLead && (
        <NoticeModal lead={selectedLead} onClose={handleClose} />
      )}
    </div>
  );
}
