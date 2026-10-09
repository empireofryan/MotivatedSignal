'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import localFont from 'next/font/local';
import styles from './index.module.css';
import { setAction } from '@/lib/actions';

const spaceGrotesk = localFont({
  src: '../../fonts/SpaceGrotesk-700.woff2',
  weight: '700',
  style: 'normal',
});
const ibmPlexMono = localFont({
  src: [
    { path: '../../fonts/IBMPlexMono-400.woff2', weight: '400', style: 'normal' },
    { path: '../../fonts/IBMPlexMono-500.woff2', weight: '500', style: 'normal' },
  ],
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface LeadModifiers {
  absentee?: boolean;
  high_equity?: boolean;
  long_tenure?: boolean;
}

interface LeadComponents {
  types?: string[];
  modifiers?: LeadModifiers;
  fresh?: boolean;
  latest_date?: string;
  [key: string]: number | string | boolean | string[] | LeadModifiers | undefined;
}

interface Lead {
  apn: string;
  score: number;
  hot: boolean;
  signalTypes: string[];
  components: LeadComponents;
  ownerName: string;
  situsAddress: string;
  situsCity: string;
  mailingAddress: string;
  absentee: boolean;
  latestDate: string | null;
  signals: Array<{ type: string; source: string; eventDate: string | null; observedDate: string | null }>;
  scoreBreakdown: Array<{ label: string; points: number }>;
  saved: boolean;
}

// Ghost placeholder for hidden-undo UI
interface HiddenPlaceholder {
  apn: string;
  _hidden: true;
  situsAddress: string;
  situsCity: string;
}

type LeadEntry = Lead | HiddenPlaceholder;

function isHiddenPlaceholder(e: LeadEntry): e is HiddenPlaceholder {
  return '_hidden' in e && e._hidden === true;
}

interface Summary {
  scored: number;
  hot: number;
  freshLast7: number;
  freshLast30: number;
  bySignal: {
    tax_delinquent: number;
    code_violation: number;
    trustee_sale: number;
    probate: number;
  };
  topCities: Array<{ city: string; n: number }>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SIGNAL_LABELS: Record<string, string> = {
  trustee_sale: 'Trustee Sale',
  tax_delinquent: 'Tax Delinquent',
  code_violation: 'Code Violation',
  probate: 'Probate',
};

const SIGNAL_COLORS: Record<string, string> = {
  trustee_sale: '#B5341F',
  tax_delinquent: '#E07B2E',
  code_violation: '#0A6B5B',
  probate: '#6B5EA8',
};

const OTHER_COLOR = '#9B9388';

const SIGNAL_VERBS: Record<string, string> = {
  trustee_sale: 'Trustee Sale — recorded',
  probate: 'Probate — filed',
  code_violation: 'Code Violation — opened',
  tax_delinquent: 'Tax Delinquent',
};

function getSignalColor(key: string): string {
  return SIGNAL_COLORS[key] ?? OTHER_COLOR;
}

function toTitleCase(snake: string): string {
  return snake.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDisplayDate(isoDate: string): string {
  const d = new Date(isoDate);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function relativeAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatDate(date: Date): string {
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

// ─── Signal Stack Bar ─────────────────────────────────────────────────────────

function SignalStackBar({
  components,
  height = 6,
  className,
}: {
  components: LeadComponents;
  height?: number;
  className?: string;
}) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const entries = Object.entries(components).filter((e): e is [string, number] => typeof e[1] === 'number');
  const total = entries.reduce((sum, [, v]) => sum + v, 0);

  if (total === 0 || entries.length === 0) return null;

  const tooltipLines = entries.map(([k, v]) => `${toTitleCase(k)}: ${v}pts`).join('\n');

  return (
    <div
      className={`${styles.stackBar} ${className ?? ''}`}
      style={{ height }}
      onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseMove={(e) => setTooltip({ x: e.clientX, y: e.clientY })}
      onMouseLeave={() => setTooltip(null)}
      title={tooltipLines}
    >
      {entries.map(([key, value]) => (
        <div
          key={key}
          className={styles.stackSegment}
          style={{
            width: `${(value / total) * 100}%`,
            background: getSignalColor(key),
          }}
        />
      ))}
      {tooltip && (
        <div
          className={styles.stackTooltip}
          style={{ left: tooltip.x + 12, top: tooltip.y - 8 }}
        >
          {entries.map(([k, v]) => (
            <div key={k} className={styles.tooltipLine}>
              <span
                className={styles.tooltipDot}
                style={{ background: getSignalColor(k) }}
              />
              <span>{toTitleCase(k)}</span>
              <span className={styles.tooltipPts}>{v}pts</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Signal Badge ─────────────────────────────────────────────────────────────

function SignalBadge({ signal }: { signal: string }) {
  const color = getSignalColor(signal);
  const label = SIGNAL_LABELS[signal] ?? toTitleCase(signal);
  return (
    <span
      className={styles.badge}
      style={{
        background: `${color}1f`,
        color,
      }}
    >
      {label.toUpperCase()}
    </span>
  );
}

// ─── Lead Row ─────────────────────────────────────────────────────────────────

function LeadRow({
  lead,
  displayScore,
  expanded,
  onToggle,
  onSaveToggle,
  onHide,
  showHidden,
}: {
  lead: Lead;
  displayScore: number;
  expanded: boolean;
  onToggle: () => void;
  onSaveToggle: () => void;
  onHide: () => void;
  showHidden: boolean;
}) {
  const modifiers = lead.components.modifiers ?? {};
  const modifierLabels: string[] = [
    ...(lead.components.fresh ? ['Fresh'] : []),
    ...(modifiers.high_equity ? ['High Equity'] : []),
    ...(modifiers.long_tenure ? ['Long Tenure'] : []),
  ];
  const mailingDiffers =
    lead.mailingAddress &&
    lead.mailingAddress.trim().toLowerCase() !== lead.situsAddress.trim().toLowerCase();

  const scoreColor = lead.hot ? '#B5341F' : '#0A6B5B';
  // In showHidden mode, API may return hidden leads — visually dim them
  const isHiddenInView = showHidden && !lead.saved && lead.signalTypes.length === 0;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  }

  function handleSave(e: React.MouseEvent) {
    e.stopPropagation();
    onSaveToggle();
  }

  function handleHide(e: React.MouseEvent) {
    e.stopPropagation();
    onHide();
  }

  return (
    <div
      className={`${styles.leadRow} ${isHiddenInView ? styles.leadRowHidden : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.leadMain}>
        {/* Score column */}
        <div className={styles.scoreCol}>
          <span
            className={styles.scoreNum}
            style={{ color: scoreColor }}
          >
            {displayScore}
          </span>
          <SignalStackBar components={lead.components} height={6} className={styles.rowStackBar} />
        </div>

        {/* Info column */}
        <div className={styles.infoCol}>
          <div className={`${styles.address} ${isHiddenInView ? styles.addressHidden : ''}`}>
            {lead.situsAddress}, {lead.situsCity}
          </div>
          {lead.latestDate && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className={styles.dateLabel} style={{ fontSize: 11, textTransform: 'none', letterSpacing: '0.02em' }}>
                {formatDisplayDate(lead.latestDate)}
              </span>
              <span className={styles.badgeAbsentee} style={{ fontSize: 10 }}>
                {relativeAge(lead.latestDate)}
              </span>
            </div>
          )}
          <div className={styles.ownerName}>{lead.ownerName}</div>
          <div className={styles.badgeRow}>
            {lead.signalTypes.map((sig) => (
              <SignalBadge key={sig} signal={sig} />
            ))}
            {lead.absentee && (
              <span className={styles.badgeAbsentee}>ABSENTEE</span>
            )}
            {modifierLabels.map((label) => (
              <span key={label} className={styles.badgeAbsentee}>{label.toUpperCase()}</span>
            ))}
          </div>
        </div>

        {/* Actions column: save + hide */}
        <div className={styles.actionsCol}>
          <button
            className={`${styles.actionBtn} ${lead.saved ? styles.actionBtnActive : ''}`}
            onClick={handleSave}
            aria-label={lead.saved ? 'Unsave lead' : 'Save lead'}
            title={lead.saved ? 'Unsave' : 'Save'}
          >
            {lead.saved ? '★' : '☆'}
          </button>
          {showHidden ? (
            <button
              className={styles.actionBtn}
              onClick={handleHide}
              aria-label="Unhide lead"
              title="Unhide"
            >
              ↩
            </button>
          ) : (
            <button
              className={styles.actionBtn}
              onClick={handleHide}
              aria-label="Hide lead"
              title="Hide"
            >
              ✕
            </button>
          )}
        </div>

        {/* Expand chevron */}
        <div className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}>
          ›
        </div>
      </div>

      {/* Expanded breakdown */}
      <div className={`${styles.expandPanel} ${expanded ? styles.expandPanelOpen : ''}`}>
        <div className={styles.expandInner}>
          <div className={styles.breakdownSection}>
            <div className={styles.sectionHeader}>SCORE BREAKDOWN</div>
            <div className={styles.divider} />
            {lead.scoreBreakdown.map((item, i) => (
              <div key={i} className={styles.breakdownRow}>
                <span className={styles.breakdownLabel}>{item.label}</span>
                <span className={styles.breakdownPts}>+{item.points} pts</span>
              </div>
            ))}
            <div className={styles.divider} />
            <div className={`${styles.breakdownRow} ${styles.breakdownTotal}`}>
              <span className={styles.breakdownLabel}>TOTAL</span>
              <span className={styles.breakdownPts}>{lead.score} pts</span>
            </div>
          </div>

          <div className={styles.breakdownSection}>
            <div className={styles.sectionHeader}>SIGNALS</div>
            <div className={styles.divider} />
            {lead.signals.map((sig, i) => {
              const dateStr = sig.type === 'tax_delinquent'
                ? (sig.observedDate ? `as of ${formatDisplayDate(sig.observedDate)}` : null)
                : (sig.eventDate ? formatDisplayDate(sig.eventDate) : null);
              const verb = SIGNAL_VERBS[sig.type] ?? sig.type;
              return (
                <div key={i} className={styles.breakdownRow}>
                  <span className={styles.breakdownLabel}>{verb}{dateStr ? ` — ${dateStr}` : ''}</span>
                </div>
              );
            })}
          </div>

          <div className={styles.breakdownSection}>
            <div className={styles.sectionHeader}>OWNER INFO</div>
            <div className={styles.divider} />
            {mailingDiffers && (
              <div className={styles.breakdownRow}>
                <span className={styles.breakdownLabel}>Mailing</span>
                <span className={styles.breakdownValue}>{lead.mailingAddress}</span>
              </div>
            )}
            <div className={styles.breakdownRow}>
              <span className={styles.breakdownLabel}>Absentee</span>
              <span className={styles.breakdownValue}>{lead.absentee ? 'YES' : 'NO'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Hidden Placeholder Row ───────────────────────────────────────────────────

function HiddenRow({
  placeholder,
  onUndo,
}: {
  placeholder: HiddenPlaceholder;
  onUndo: () => void;
}) {
  return (
    <div className={styles.hiddenRow}>
      <span className={styles.hiddenRowText}>
        Hidden · {placeholder.situsAddress}, {placeholder.situsCity}
      </span>
      <button
        className={styles.undoBtn}
        onClick={(e) => { e.stopPropagation(); onUndo(); }}
        aria-label="Undo hide"
      >
        Undo
      </button>
    </div>
  );
}

// ─── Summary Header ───────────────────────────────────────────────────────────

function SummaryHeader({
  summary,
  savedOnly,
  showHidden,
  onToggleSavedOnly,
  onToggleShowHidden,
}: {
  summary: Summary;
  savedOnly: boolean;
  showHidden: boolean;
  onToggleSavedOnly: () => void;
  onToggleShowHidden: () => void;
}) {
  const signals = Object.entries(summary.bySignal) as [string, number][];
  const sigTotal = signals.reduce((s, [, v]) => s + v, 0);

  // Signal breakdown short labels for inline KPI line
  const sigBreakdown = [
    { key: 'trustee_sale', short: 'Trustee' },
    { key: 'tax_delinquent', short: 'Tax' },
    { key: 'code_violation', short: 'Code' },
    { key: 'probate', short: 'Probate' },
  ];

  return (
    <header className={styles.header}>
      <div className={styles.headerTop}>
        <div>
          <h1 className={styles.title}>Maricopa County</h1>
          <p className={styles.subtitle}>Motivated sellers</p>
        </div>
        <time className={styles.dateLabel}>{formatDate(new Date())}</time>
      </div>
      <div className={styles.headerDivider} />

      {/* KPI strip */}
      <div className={styles.kpiStrip}>
        <span className={styles.kpiItem}>
          <span className={styles.kpiNum}>{summary.scored}</span>
          <span className={styles.kpiLabel}>scored</span>
        </span>
        <span className={styles.kpiDot} aria-hidden="true">·</span>
        <span className={styles.kpiItem}>
          <span className={`${styles.kpiNum} ${styles.kpiNumHot}`}>{summary.hot}</span>
          <span className={styles.kpiLabel}>hot</span>
        </span>
        <span className={styles.kpiDot} aria-hidden="true">·</span>
        <span className={styles.kpiItem}>
          <span className={`${styles.kpiNum} ${styles.kpiNumFresh}`}>{summary.freshLast7}</span>
          <span className={styles.kpiLabel}>new (7d)</span>
        </span>
      </div>

      {/* Signal breakdown */}
      <div className={styles.sigRow}>
        {sigBreakdown.map(({ key, short }, i) => {
          const val = summary.bySignal[key as keyof typeof summary.bySignal] ?? 0;
          return (
            <span key={key} className={styles.sigChip}>
              {i > 0 && <span className={styles.kpiDot} aria-hidden="true">·</span>}
              <span
                className={styles.sigChipDot}
                style={{ background: getSignalColor(key) }}
                aria-hidden="true"
              />
              <span className={styles.sigChipLabel}>{short}</span>
              <span className={styles.sigChipCount}>{val}</span>
            </span>
          );
        })}
        {sigTotal > 0 && (
          <div className={styles.sigBar} aria-hidden="true">
            {signals.map(([key, val]) => (
              <div
                key={key}
                className={styles.sigSegment}
                style={{
                  width: `${(val / sigTotal) * 100}%`,
                  background: getSignalColor(key),
                }}
                title={`${SIGNAL_LABELS[key] ?? key}: ${val}`}
              />
            ))}
          </div>
        )}
      </div>

      {/* Filter chips */}
      <div className={styles.filterRow}>
        <button
          className={`${styles.filterBtn} ${savedOnly ? styles.filterBtnActive : ''}`}
          onClick={onToggleSavedOnly}
          aria-pressed={savedOnly}
        >
          ★ Saved only
        </button>
        <button
          className={`${styles.filterBtn} ${showHidden ? styles.filterBtnActive : ''}`}
          onClick={onToggleShowHidden}
          aria-pressed={showHidden}
        >
          ◎ Show hidden
        </button>
      </div>
    </header>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function IndexPage() {
  const [entries, setEntries] = useState<LeadEntry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [displayScores, setDisplayScores] = useState<Record<string, number>>({});
  const animFrameRefs = useRef<Record<string, number>>({});

  // Filter state
  const [savedOnly, setSavedOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  // Fetch data whenever filters change
  const fetchLeads = useCallback(async (opts: { savedOnly: boolean; showHidden: boolean }) => {
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (opts.savedOnly) params.set('savedOnly', '1');
      if (opts.showHidden) params.set('includeHidden', '1');

      const [leadsRes, summaryRes] = await Promise.all([
        fetch(`/api/leads?${params}`),
        fetch('/api/summary'),
      ]);
      if (!leadsRes.ok || !summaryRes.ok) throw new Error('API error');
      const [leadsData, summaryData] = await Promise.all([
        leadsRes.json(),
        summaryRes.json(),
      ]);
      const sorted: Lead[] = [...leadsData].sort((a: Lead, b: Lead) => b.score - a.score);
      setEntries(sorted);
      setSummary(summaryData);
      setLoading(false);
    } catch {
      setError('Failed to load index');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchLeads({ savedOnly, showHidden });
  }, [savedOnly, showHidden, fetchLeads]);

  // Count-up animation — only triggers on real Lead entries
  const leads = entries.filter((e): e is Lead => !isHiddenPlaceholder(e));

  useEffect(() => {
    if (leads.length === 0) return;

    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReduced) {
      const immediate: Record<string, number> = {};
      leads.forEach((l) => { immediate[l.apn] = l.score; });
      setDisplayScores(immediate);
      return;
    }

    const initialScores: Record<string, number> = {};
    leads.forEach((l) => { initialScores[l.apn] = 0; });
    setDisplayScores(initialScores);

    const DURATION = 1200;
    leads.forEach((lead, idx) => {
      const delay = idx * 50;
      const startTime: { t: number | null } = { t: null };

      function step(ts: number) {
        if (startTime.t === null) startTime.t = ts;
        const elapsed = ts - startTime.t;
        const progress = Math.min(elapsed / DURATION, 1);
        // ease-out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(eased * lead.score);
        setDisplayScores((prev) => ({ ...prev, [lead.apn]: current }));
        if (progress < 1) {
          animFrameRefs.current[lead.apn] = requestAnimationFrame(step);
        }
      }

      const timeoutId = setTimeout(() => {
        animFrameRefs.current[lead.apn] = requestAnimationFrame(step);
      }, delay);

      // Store timeout for cleanup (encode as negative)
      animFrameRefs.current[`timeout_${lead.apn}`] = timeoutId as unknown as number;
    });

    return () => {
      Object.entries(animFrameRefs.current).forEach(([key, id]) => {
        if (key.startsWith('timeout_')) clearTimeout(id);
        else cancelAnimationFrame(id);
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  function toggleExpanded(apn: string) {
    setExpanded((prev) => ({ ...prev, [apn]: !prev[apn] }));
  }

  // Save toggle: optimistic flip
  function handleSaveToggle(apn: string) {
    setEntries((prev) =>
      prev.map((e) => {
        if (isHiddenPlaceholder(e) || e.apn !== apn) return e;
        const next = { ...e, saved: !e.saved };
        setAction(apn, 'saved', next.saved).catch(() => {
          // revert on error
          setEntries((p) =>
            p.map((x) => (isHiddenPlaceholder(x) || x.apn !== apn ? x : { ...x, saved: e.saved }))
          );
        });
        return next;
      })
    );
  }

  // Hide: optimistically replace with ghost placeholder
  function handleHide(apn: string) {
    const target = entries.find((e) => !isHiddenPlaceholder(e) && e.apn === apn) as Lead | undefined;
    if (!target) return;

    const placeholder: HiddenPlaceholder = {
      apn,
      _hidden: true,
      situsAddress: target.situsAddress,
      situsCity: target.situsCity,
    };

    setEntries((prev) => prev.map((e) => (isHiddenPlaceholder(e) || e.apn !== apn ? e : placeholder)));
    setAction(apn, 'hidden', true).catch(() => {
      // revert
      setEntries((prev) => prev.map((e) => (isHiddenPlaceholder(e) && e.apn === apn ? target : e)));
    });
  }

  // Unhide (in showHidden mode)
  function handleUnhide(apn: string) {
    setAction(apn, 'hidden', false).then(() => {
      // Refetch to get fresh state
      fetchLeads({ savedOnly, showHidden });
    }).catch(() => {/* silent */});
  }

  // Undo hide (from ghost row)
  function handleUndoHide(apn: string) {
    setAction(apn, 'hidden', false).then(() => {
      fetchLeads({ savedOnly, showHidden });
    }).catch(() => {/* silent */});
  }

  const fontVars = {
    '--font-display': spaceGrotesk.style.fontFamily,
    '--font-mono': ibmPlexMono.style.fontFamily,
  } as React.CSSProperties;

  if (loading) {
    return (
      <div className={styles.page} style={fontVars}>
        <div className={styles.centered}>
          <span className={styles.loadingText}>Loading index…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.page} style={fontVars}>
        <div className={styles.centered}>
          <span className={styles.errorText}>{error}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page} style={fontVars}>
      <div className={styles.container}>
        {summary && (
          <SummaryHeader
            summary={summary}
            savedOnly={savedOnly}
            showHidden={showHidden}
            onToggleSavedOnly={() => setSavedOnly((v) => !v)}
            onToggleShowHidden={() => setShowHidden((v) => !v)}
          />
        )}
        <div className={styles.ledger}>
          {entries.map((entry) => {
            if (isHiddenPlaceholder(entry)) {
              return (
                <HiddenRow
                  key={entry.apn}
                  placeholder={entry}
                  onUndo={() => handleUndoHide(entry.apn)}
                />
              );
            }
            const lead = entry;
            return (
              <LeadRow
                key={lead.apn}
                lead={lead}
                displayScore={displayScores[lead.apn] ?? 0}
                expanded={!!expanded[lead.apn]}
                onToggle={() => toggleExpanded(lead.apn)}
                onSaveToggle={() => handleSaveToggle(lead.apn)}
                onHide={() => showHidden ? handleUnhide(lead.apn) : handleHide(lead.apn)}
                showHidden={showHidden}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
