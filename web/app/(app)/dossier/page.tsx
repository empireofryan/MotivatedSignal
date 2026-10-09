'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import localFont from 'next/font/local';
import { setAction } from '@/lib/actions';
import styles from './dossier.module.css';

/* ── Fonts ─────────────────────────────────────────────────── */
const archivoNarrow = localFont({
  src: [
    { path: '../../fonts/ArchivoNarrow-400-Normal.woff2', weight: '400', style: 'normal' },
    { path: '../../fonts/ArchivoNarrow-400-Italic.woff2', weight: '400', style: 'italic' },
    { path: '../../fonts/ArchivoNarrow-500-Normal.woff2', weight: '500', style: 'normal' },
    { path: '../../fonts/ArchivoNarrow-500-Italic.woff2', weight: '500', style: 'italic' },
    { path: '../../fonts/ArchivoNarrow-600-Normal.woff2', weight: '600', style: 'normal' },
    { path: '../../fonts/ArchivoNarrow-600-Italic.woff2', weight: '600', style: 'italic' },
    { path: '../../fonts/ArchivoNarrow-700-Normal.woff2', weight: '700', style: 'normal' },
    { path: '../../fonts/ArchivoNarrow-700-Italic.woff2', weight: '700', style: 'italic' },
  ],
  variable: '--font-archivo-narrow',
  display: 'swap',
});

const ibmPlexMono = localFont({
  src: [
    { path: '../../fonts/IBMPlexMono-400.woff2', weight: '400', style: 'normal' },
    { path: '../../fonts/IBMPlexMono-500.woff2', weight: '500', style: 'normal' },
    { path: '../../fonts/IBMPlexMono-600.woff2', weight: '600', style: 'normal' },
    { path: '../../fonts/IBMPlexMono-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});

/* ── Types ──────────────────────────────────────────────────── */
interface Signal {
  type: string;
  source: string;
  eventDate: string | null;
  observedDate: string | null;
}

interface ScoreBreakdownItem {
  label: string;
  points: number;
}

interface Lead {
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
  latestDate: string | null;
  signals: Signal[];
  scoreBreakdown: ScoreBreakdownItem[];
  saved: boolean;
}

interface Summary {
  scored: number;
  hot: number;
  freshLast7?: number;
  freshLast30?: number;
  bySignal: Record<string, number>;
  topCities: { city: string; n: number }[];
}

/* ── Constants ──────────────────────────────────────────────── */
const SIGNAL_LABELS: Record<string, string> = {
  trustee_sale: 'Trustee Sale',
  tax_delinquent: 'Tax Delinquent',
  code_violation: 'Code Violation',
  probate: 'Probate',
};

const SIGNAL_VERBS: Record<string, string> = {
  trustee_sale: 'recorded',
  probate: 'filed',
  code_violation: 'opened',
  tax_delinquent: 'flagged',
};

const COMPONENT_LABELS: Record<string, string> = {
  tax_delinquent: 'Tax Delinquent',
  code_violation: 'Code Violation',
  trustee_sale: 'Trustee Sale',
  probate: 'Probate',
  absentee: 'Absentee Owner',
  vacant: 'Vacancy',
  pre_foreclosure: 'Pre-Foreclosure',
  equity: 'Equity',
};

function signalLabel(key: string): string {
  return (
    SIGNAL_LABELS[key] ??
    key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/* ── Date utils ─────────────────────────────────────────────── */
function fmtAbsDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 14) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 6) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/* ── Score fill width (cap at 160 for full bar) ─────────────── */
function scorePct(score: number): number {
  return Math.min(100, Math.round((score / 160) * 100));
}

/* ── Format APN for display ─────────────────────────────────── */
function fmtApn(apn: string): string {
  return `APN ${apn}`;
}

/* ── Component value formatting ──────────────────────────────── */
function fmtComponentValue(val: unknown): string {
  if (typeof val === 'boolean') return val ? 'YES' : 'NO';
  if (typeof val === 'number') return val.toString();
  if (typeof val === 'string') return val.toUpperCase();
  return String(val);
}

function isHighComponent(key: string, val: unknown): boolean {
  if (typeof val === 'boolean' && val) return true;
  if (typeof val === 'number' && val > 0) return true;
  if (key === 'trustee_sale' || key === 'tax_delinquent') return !!val;
  return false;
}

/* ── Fetch leads helper ─────────────────────────────────────── */
async function fetchLeads(params: URLSearchParams): Promise<Lead[]> {
  const res = await fetch(`/api/leads?${params.toString()}`);
  if (!res.ok) throw new Error(`Leads: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as Lead[] | { leads?: Lead[] } | { error: string };
  if ('error' in data) throw new Error((data as { error: string }).error);
  return Array.isArray(data) ? data : ((data as { leads?: Lead[] }).leads ?? []);
}

/* ── Date Badge ──────────────────────────────────────────────── */
function DateBadge({ iso }: { iso: string | null }) {
  if (!iso) return null;
  return (
    <div className={styles.dateBadgeWrap}>
      <span className={styles.dateBadge}>{relativeTime(iso)}</span>
      <span className={styles.dateLabel}>{fmtAbsDate(iso)}</span>
    </div>
  );
}

/* ── Plain Field (paid view) ─────────────────────────────────── */
function PlainField({ label, value }: { label: string; value: string | null }) {
  return (
    <div className={styles.plainField}>
      <span className={styles.plainLabel}>{label}</span>
      <span className={styles.plainValue}>{value ?? '—'}</span>
    </div>
  );
}

/* ── Redacted Field (trial view) ─────────────────────────────── */
function RedactedField({ label, value }: { label: string; value: string | null }) {
  const display = value ?? 'UNKNOWN';
  return (
    <div className={styles.redactedField}>
      <span className={styles.redactLabel}>{label}</span>
      <div className={styles.redactWrap}>
        <span className={styles.redactContent} aria-label={`${label}: ${display}`}>
          {display}
        </span>
        <div className={styles.redactBar} aria-hidden="true" />
        <div className={styles.lockOverlay} aria-hidden="true">
          🔒 Upgrade to reveal contact
        </div>
      </div>
    </div>
  );
}

/* ── Owner Field (switches on trialMode) ─────────────────────── */
function OwnerField({
  label,
  value,
  trialMode,
}: {
  label: string;
  value: string | null;
  trialMode: boolean;
}) {
  if (trialMode) return <RedactedField label={label} value={value} />;
  return <PlainField label={label} value={value} />;
}

/* ── Evidence Tags ───────────────────────────────────────────── */
function EvidenceTags({ signals }: { signals: string[] }) {
  if (!signals.length) return null;
  return (
    <div className={styles.evidenceTags} role="list" aria-label="Evidence signals">
      {signals.map((s) => (
        <span
          key={s}
          role="listitem"
          className={`${styles.evidenceTag} ${
            s === 'trustee_sale'
              ? styles.evidenceTagAlert
              : s === 'probate'
                ? styles.evidenceTagGraphite
                : ''
          }`}
        >
          {signalLabel(s)}
        </span>
      ))}
    </div>
  );
}

/* ── Signal Timeline ─────────────────────────────────────────── */
function SignalTimeline({ signals }: { signals: Signal[] }) {
  if (!signals.length) return null;
  const sorted = [...signals].sort((a, b) => {
    const da = a.eventDate ?? a.observedDate ?? '';
    const db = b.eventDate ?? b.observedDate ?? '';
    return db.localeCompare(da);
  });
  return (
    <div className={styles.drawerSection}>
      <div className={styles.drawerSectionTitle}>Signal History</div>
      {sorted.map((sig, i) => {
        const dateStr = sig.eventDate ?? sig.observedDate;
        const verb = SIGNAL_VERBS[sig.type] ?? 'noted';
        return (
          <div key={i} className={styles.timelineItem}>
            <span className={styles.timelineDate}>
              {dateStr ? fmtAbsDate(dateStr) : '—'}
            </span>
            <span className={styles.timelineSep}>—</span>
            <span className={styles.timelineText}>
              {signalLabel(sig.type)} {verb}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Score Breakdown ─────────────────────────────────────────── */
function ScoreBreakdown({
  breakdown,
  total,
}: {
  breakdown: ScoreBreakdownItem[];
  total: number;
}) {
  if (!breakdown.length) return null;
  return (
    <div className={styles.drawerSection}>
      <div className={styles.drawerSectionTitle}>Score Breakdown</div>
      <div className={styles.scoreBreakdownTable}>
        {breakdown.map((item, i) => (
          <div key={i} className={styles.scoreBreakdownRow}>
            <span className={styles.scoreBreakdownLabel}>{item.label}</span>
            <span className={styles.scoreBreakdownDots} aria-hidden="true" />
            <span className={styles.scoreBreakdownPoints}>+{item.points}</span>
          </div>
        ))}
        <div className={`${styles.scoreBreakdownRow} ${styles.scoreBreakdownTotal}`}>
          <span className={styles.scoreBreakdownLabel}>TOTAL</span>
          <span className={styles.scoreBreakdownDots} aria-hidden="true" />
          <span className={styles.scoreBreakdownPoints}>{total}</span>
        </div>
      </div>
    </div>
  );
}

/* ── Expanded Record Drawer ──────────────────────────────────── */
function RecordDrawer({
  lead,
  trialMode,
  onClose,
}: {
  lead: Lead;
  trialMode: boolean;
  onClose: () => void;
}) {

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const componentEntries = Object.entries(lead.components ?? {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== 0 && v !== false,
  );

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Case record: ${lead.apn}`}
    >
      <div className={styles.drawer}>
        {/* Drawer Header */}
        <div className={styles.drawerHeader}>
          <div className={styles.drawerCaseNum}>{fmtApn(lead.apn)}</div>
          <div className={styles.drawerAddress}>
            {lead.situsAddress ?? 'Address Unavailable'}
          </div>
          {lead.situsCity && (
            <div className={styles.drawerCity}>{lead.situsCity}, AZ</div>
          )}
          <button className={styles.drawerClose} onClick={onClose} aria-label="Close record">
            Close ✕
          </button>
        </div>

        {/* Drawer Body */}
        <div className={styles.drawerBody}>
          {/* Score */}
          <div className={styles.drawerSection}>
            <div className={styles.drawerSectionTitle}>Distress Score</div>
            <div className={styles.scoreRow}>
              <span className={styles.scoreNumber}>{lead.score}</span>
              <div
                className={styles.scoreMeter}
                role="progressbar"
                aria-valuenow={lead.score}
                aria-valuemax={160}
                aria-label="Distress score meter"
              >
                <div
                  className={`${styles.scoreFill} ${lead.hot ? styles.scoreFillHot : ''}`}
                  style={{ width: `${scorePct(lead.score)}%` }}
                />
              </div>
              <span className={styles.scoreCapLabel}>/ 160 MAX</span>
            </div>
            <EvidenceTags signals={lead.signalTypes} />
            {lead.hot && (
              <div className={styles.absenteePill} aria-label="Active hot lead">
                ● ACTIVE HOT LEAD
              </div>
            )}
          </div>

          {/* Score Breakdown */}
          {lead.scoreBreakdown?.length > 0 && (
            <ScoreBreakdown breakdown={lead.scoreBreakdown} total={lead.score} />
          )}

          {/* Signal Timeline */}
          {lead.signals?.length > 0 && (
            <SignalTimeline signals={lead.signals} />
          )}

          {/* Owner of Record */}
          <div className={styles.drawerSection}>
            <div className={styles.drawerSectionTitle}>Owner of Record</div>
            <div className={styles.drawerField}>
              <div className={styles.drawerFieldLabel}>Registered Owner</div>
              {trialMode ? (
                <RedactedField label="Registered Owner" value={lead.ownerName} />
              ) : (
                <div className={styles.drawerFieldValue}>{lead.ownerName ?? '—'}</div>
              )}
            </div>
            <div className={styles.drawerField}>
              <div className={styles.drawerFieldLabel}>Property Address</div>
              <div className={styles.drawerFieldValue}>
                {lead.situsAddress ?? '—'}
                {lead.situsCity ? `, ${lead.situsCity}, AZ` : ''}
              </div>
            </div>
            <div className={styles.drawerField}>
              <div className={styles.drawerFieldLabel}>Mailing Address</div>
              {trialMode ? (
                <RedactedField label="Mailing Address" value={lead.mailingAddress} />
              ) : (
                <div className={styles.drawerFieldValue}>{lead.mailingAddress ?? '—'}</div>
              )}
            </div>
            {lead.absentee && (
              <div
                className={styles.absenteePill}
                aria-label="Absentee owner — mailing differs from property"
              >
                ◈ ABSENTEE OWNER
              </div>
            )}
          </div>

          {/* Why Flagged */}
          {componentEntries.length > 0 && (
            <div className={styles.drawerSection}>
              <div className={styles.drawerSectionTitle}>Why Flagged</div>
              <div className={styles.componentGrid}>
                {componentEntries.map(([key, val]) => (
                  <div key={key} className={styles.componentItem}>
                    <div className={styles.componentKey}>
                      {COMPONENT_LABELS[key] ?? signalLabel(key)}
                    </div>
                    <div
                      className={`${styles.componentVal} ${
                        isHighComponent(key, val) ? styles.componentValHigh : ''
                      }`}
                    >
                      {fmtComponentValue(val)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Case Reference */}
          <div className={styles.drawerSection}>
            <div className={styles.drawerSectionTitle}>Case Reference</div>
            <div className={styles.drawerField}>
              <div className={styles.drawerFieldLabel}>APN</div>
              <div className={styles.drawerFieldValue}>{lead.apn}</div>
            </div>
            <div className={styles.drawerField}>
              <div className={styles.drawerFieldLabel}>Jurisdiction</div>
              <div className={styles.drawerFieldValue}>MARICOPA COUNTY, AZ</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Dossier Card ────────────────────────────────────────────── */
function DossierCard({
  lead,
  trialMode,
  isSaved,
  isHidden,
  showHidden,
  onOpen,
  onSave,
  onHide,
  onUnhide,
}: {
  lead: Lead;
  trialMode: boolean;
  isSaved: boolean;
  isHidden: boolean;
  showHidden: boolean;
  onOpen: (lead: Lead) => void;
  onSave: (apn: string, saved: boolean) => void;
  onHide: (apn: string) => void;
  onUnhide: (apn: string) => void;
}) {
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(lead);
    }
  };

  const handleSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSave(lead.apn, !isSaved);
  };

  const handleHide = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isHidden) {
      onUnhide(lead.apn);
    } else {
      onHide(lead.apn);
    }
  };

  return (
    <article
      className={`${styles.card} ${lead.hot ? styles.cardHot : ''} ${isHidden ? styles.hiddenCard : ''}`}
      onClick={() => !isHidden && onOpen(lead)}
      onKeyDown={handleKey}
      tabIndex={0}
      role="button"
      aria-label={`Open case file: ${lead.situsAddress ?? lead.apn}`}
    >
      {isHidden && showHidden && (
        <div className={styles.hiddenBadge} aria-label="Hidden lead">HIDDEN</div>
      )}

      {/* Header */}
      <div className={styles.cardHeader}>
        <div className={styles.caseInfo}>
          <div className={styles.caseNumber}>{fmtApn(lead.apn)}</div>
          <div
            className={styles.caseAddress}
            title={lead.situsAddress ?? 'Address Unavailable'}
          >
            {lead.situsAddress ?? 'Address Unavailable'}
          </div>
          {lead.situsCity && (
            <div className={styles.caseCity}>{lead.situsCity}, AZ</div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className={styles.cardBody}>
        {/* Score bar */}
        <div className={styles.scoreRow}>
          <span className={styles.scoreNumber}>{lead.score}</span>
          <div
            className={styles.scoreMeter}
            role="progressbar"
            aria-valuenow={lead.score}
            aria-valuemax={160}
            aria-label="Distress score"
          >
            <div
              className={`${styles.scoreFill} ${lead.hot ? styles.scoreFillHot : ''}`}
              style={{ width: `${scorePct(lead.score)}%` }}
            />
          </div>
          <span className={styles.scoreCapLabel}>SCORE</span>
        </div>

        {/* Evidence signals */}
        <EvidenceTags signals={lead.signalTypes} />

        {/* Date */}
        <DateBadge iso={lead.latestDate} />

        {/* Owner */}
        <OwnerField label="Owner of Record" value={lead.ownerName} trialMode={trialMode} />

        {/* Mailing (absentee only) */}
        {lead.absentee && (
          <OwnerField label="Mailing Address" value={lead.mailingAddress} trialMode={trialMode} />
        )}

        {lead.absentee && (
          <div className={styles.absenteePill} aria-label="Absentee owner">
            ◈ ABSENTEE OWNER
          </div>
        )}
      </div>

      {/* Footer */}
      <div className={styles.cardFooter}>
        <button
          className={`${styles.saveBtn} ${isSaved ? styles.saveBtnActive : ''}`}
          onClick={handleSave}
          aria-label={isSaved ? 'Unsave lead' : 'Save lead'}
          aria-pressed={isSaved}
          title={isSaved ? 'Saved' : 'Save'}
        >
          {isSaved ? '★' : '☆'}
        </button>
        <button
          className={styles.hideBtn}
          onClick={handleHide}
          aria-label={isHidden ? 'Unhide lead' : 'Hide lead'}
          title={isHidden ? 'Unhide' : 'Hide'}
        >
          {isHidden ? '↩' : '✕'}
        </button>
        <span className={styles.cardActionsSpace} />
        <span className={styles.footerAction}>View</span>
        <span className={styles.footerArrow} aria-hidden="true">→</span>
      </div>
    </article>
  );
}

/* ── Stats Bar ───────────────────────────────────────────────── */
function StatsBar({ summary }: { summary: Summary }) {
  const ORDERED_SIGNALS = ['trustee_sale', 'tax_delinquent', 'code_violation', 'probate'];
  const SIGNAL_SHORT: Record<string, string> = {
    trustee_sale: 'Trustee',
    tax_delinquent: 'Tax',
    code_violation: 'Code',
    probate: 'Probate',
  };
  return (
    <div className={styles.statsBar}>
      <div className={styles.statsBarInner}>
        <div className={styles.statBlock}>
          <span className={styles.statValue}>{summary.scored.toLocaleString()}</span>
          <span className={styles.statLabel}>Scored</span>
        </div>
        <div className={styles.statDivider} aria-hidden="true" />
        <div className={styles.statBlock}>
          <span
            className={styles.statValue}
            style={{ color: '#C8102E' }}
            aria-label={`${summary.hot.toLocaleString()} hot leads`}
          >
            {summary.hot.toLocaleString()}
          </span>
          <span className={styles.statLabel}>Hot</span>
        </div>
        {summary.freshLast7 != null && (
          <>
            <div className={styles.statDivider} aria-hidden="true" />
            <div className={styles.statBlock}>
              <span
                className={styles.statValue}
                style={{ color: '#2E7D32' }}
                aria-label={`${summary.freshLast7.toLocaleString()} new distress events in last 7 days`}
              >
                {summary.freshLast7.toLocaleString()}
              </span>
              <span className={styles.statLabel}>New (7d)</span>
            </div>
          </>
        )}
        <div className={styles.statDivider} aria-hidden="true" />
        <div className={styles.signalRow} aria-label="Signal breakdown">
          {ORDERED_SIGNALS.map((sig) => {
            const count = summary.bySignal[sig] ?? 0;
            if (!count) return null;
            return (
              <div key={sig} className={styles.signalStat}>
                <span className={styles.signalCount}>{count.toLocaleString()}</span>
                <span className={styles.signalName}>{SIGNAL_SHORT[sig] ?? signalLabel(sig)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── Loading / Error / Empty states ─────────────────────────── */
function LoadingState() {
  return (
    <div className={styles.stateWrap} aria-live="polite" aria-busy="true">
      <span className={styles.stateCode}>RETRIEVING FILES</span>
      <span className={styles.stateMessage}>Pulling Case Files</span>
      <div className={styles.loadingDots} aria-hidden="true">
        <span className={styles.loadingDot} />
        <span className={styles.loadingDot} />
        <span className={styles.loadingDot} />
      </div>
      <span className={styles.stateSubtext}>Querying Maricopa County records…</span>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className={styles.stateWrap} role="alert">
      <span className={styles.stateCode}>ACCESS FAILED</span>
      <span className={styles.stateMessage}>Records Unavailable</span>
      <span className={styles.stateSubtext}>{message}</span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className={styles.stateWrap}>
      <span className={styles.stateCode}>NO RESULTS</span>
      <span className={styles.stateMessage}>No Case Files Found</span>
      <span className={styles.stateSubtext}>No leads matched the current criteria.</span>
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────── */
export default function DossierPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Lead | null>(null);

  // Feature toggles
  const [trialMode, setTrialMode] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  // Optimistic action state
  const [savedApns, setSavedApns] = useState<Set<string>>(new Set());
  const [hiddenApns, setHiddenApns] = useState<Set<string>>(new Set());
  const [undoEntry, setUndoEntry] = useState<{ apn: string; lead: Lead } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  // Fetch leads when filter params change
  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (savedOnly) params.set('savedOnly', '1');
        if (showHidden) params.set('includeHidden', '1');

        const [fetched, summaryRes] = await Promise.all([
          fetchLeads(params),
          fetch('/api/summary'),
        ]);

        if (!summaryRes.ok)
          throw new Error(`Summary: ${summaryRes.status} ${summaryRes.statusText}`);
        const summaryData = (await summaryRes.json()) as Summary | { error: string };
        if ('error' in summaryData) throw new Error(summaryData.error);

        setLeads(fetched);
        setSavedApns(new Set(fetched.filter((l) => l.saved).map((l) => l.apn)));
        setSummary(summaryData);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [savedOnly, showHidden]);

  const openRecord = useCallback((lead: Lead) => setSelected(lead), []);
  const closeRecord = useCallback(() => setSelected(null), []);

  const handleSave = useCallback(
    async (apn: string, on: boolean) => {
      setSavedApns((prev) => {
        const next = new Set(prev);
        if (on) next.add(apn);
        else next.delete(apn);
        return next;
      });
      try {
        await setAction(apn, 'saved', on);
      } catch {
        // rollback
        setSavedApns((prev) => {
          const next = new Set(prev);
          if (on) next.delete(apn);
          else next.add(apn);
          return next;
        });
      }
    },
    [],
  );

  const handleHide = useCallback(
    async (apn: string) => {
      const lead = leads.find((l) => l.apn === apn);
      if (!lead) return;
      setHiddenApns((prev) => new Set([...prev, apn]));
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      setUndoEntry({ apn, lead });
      undoTimerRef.current = setTimeout(() => setUndoEntry(null), 5000);
      try {
        await setAction(apn, 'hidden', true);
      } catch {
        setHiddenApns((prev) => {
          const next = new Set(prev);
          next.delete(apn);
          return next;
        });
      }
    },
    [leads],
  );

  const handleUnhide = useCallback(async (apn: string) => {
    setHiddenApns((prev) => {
      const next = new Set(prev);
      next.delete(apn);
      return next;
    });
    try {
      await setAction(apn, 'hidden', false);
    } catch {
      setHiddenApns((prev) => new Set([...prev, apn]));
    }
  }, []);

  const handleUndoHide = useCallback(() => {
    if (!undoEntry) return;
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    handleUnhide(undoEntry.apn);
    setUndoEntry(null);
  }, [undoEntry, handleUnhide]);

  const displayedLeads = showHidden
    ? leads
    : leads.filter((l) => !hiddenApns.has(l.apn));

  return (
    <div className={`${styles.root} ${archivoNarrow.variable} ${ibmPlexMono.variable}`}>
      {/* Masthead */}
      <header className={styles.masthead}>
        <div className={styles.mastheadInner}>
          <div className={styles.mastheadTitleBlock}>
            <h1 className={styles.mastheadTitle}>Maricopa County</h1>
            <span className={styles.mastheadSubtitle}>Motivated sellers</span>
          </div>
          <div className={styles.mastheadMid} />
          {/* Trial mode toggle */}
          <button
            className={`${styles.trialToggle} ${trialMode ? styles.trialToggleOn : ''}`}
            onClick={() => setTrialMode((v) => !v)}
            aria-pressed={trialMode}
            aria-label="Toggle free trial preview mode"
          >
            Free trial preview
            <span className={styles.trialToggleDot}>{trialMode ? '●' : '○'}</span>
          </button>
        </div>

        {/* Filter toggles */}
        <div className={styles.filterToggles}>
          <div className={styles.filterTogglesInner}>
            <button
              className={`${styles.filterToggle} ${savedOnly ? styles.filterToggleActive : ''}`}
              onClick={() => setSavedOnly((v) => !v)}
              aria-pressed={savedOnly}
            >
              ★ Saved only
            </button>
            <button
              className={`${styles.filterToggle} ${showHidden ? styles.filterToggleActive : ''}`}
              onClick={() => setShowHidden((v) => !v)}
              aria-pressed={showHidden}
            >
              Show hidden
            </button>
          </div>
        </div>

        {summary && <StatsBar summary={summary} />}
      </header>

      {/* Main content */}
      <main className={styles.body}>
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} />
        ) : displayedLeads.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>Leads</span>
              <span className={styles.sectionCount}>{displayedLeads.length} records</span>
            </div>
            <div className={styles.leadGrid}>
              {displayedLeads.map((lead) => (
                <DossierCard
                  key={lead.apn}
                  lead={lead}
                  trialMode={trialMode}
                  isSaved={savedApns.has(lead.apn)}
                  isHidden={hiddenApns.has(lead.apn)}
                  showHidden={showHidden}
                  onOpen={openRecord}
                  onSave={handleSave}
                  onHide={handleHide}
                  onUnhide={handleUnhide}
                />
              ))}
            </div>
          </>
        )}
      </main>

      {/* Undo banner */}
      {undoEntry && (
        <div className={styles.undoBanner} role="status">
          <span className={styles.undoBannerText}>Lead hidden</span>
          <button className={styles.undoBannerBtn} onClick={handleUndoHide}>
            Undo
          </button>
          <button
            className={styles.undoBannerDismiss}
            onClick={() => setUndoEntry(null)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Expanded record drawer */}
      {selected && (
        <RecordDrawer lead={selected} trialMode={trialMode} onClose={closeRecord} />
      )}
    </div>
  );
}
