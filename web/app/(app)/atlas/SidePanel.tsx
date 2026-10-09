'use client'

import { useEffect, useRef, useState } from 'react'
import type { Lead, Summary } from './page'
import styles from './atlas.module.css'

function formatMonD(isoDate: string): string {
  const d = new Date(isoDate)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`
}

function relativeAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  if (days === 0) return 'today'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function formatSignalDate(isoDate: string): string {
  const d = new Date(isoDate)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

const SIGNAL_LABELS: Record<string, string> = {
  trustee_sale: 'Trustee Sale',
  tax_delinquent: 'Tax Delinquent',
  code_violation: 'Code Violation',
  probate: 'Probate',
}

const SIGNAL_CSS: Record<string, string> = {
  trustee_sale: styles.tagTrusteeSale,
  tax_delinquent: styles.tagTaxDelinquent,
  code_violation: styles.tagCodeViolation,
  probate: styles.tagProbate,
}

interface Props {
  leads: Lead[]
  summary: Summary | null
  selectedLead: Lead | null
  hoveredApn: string | null
  savedApns: Set<string>
  hiddenApns: Set<string>
  showSavedOnly: boolean
  showHidden: boolean
  onSelectLead: (lead: Lead | null) => void
  onHoverApn: (apn: string | null) => void
  onToggleSaved: (apn: string) => void
  onToggleHidden: (apn: string) => void
  onUndoHide: (apn: string) => void
  onToggleSavedOnly: () => void
  onToggleShowHidden: () => void
}

export default function SidePanel({
  leads,
  summary,
  selectedLead,
  hoveredApn,
  savedApns,
  hiddenApns,
  showSavedOnly,
  showHidden,
  onSelectLead,
  onHoverApn,
  onToggleSaved,
  onToggleHidden,
  onUndoHide,
  onToggleSavedOnly,
  onToggleShowHidden,
}: Props) {
  const activeRowRef = useRef<HTMLDivElement>(null)
  // Track last-hidden APN for undo toast (null = no toast)
  const [undoApn, setUndoApn] = useState<string | null>(null)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Scroll hovered row into view
  useEffect(() => {
    if (hoveredApn && activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [hoveredApn])

  // When a lead is hidden, show undo toast for 4s
  function handleHide(apn: string) {
    onToggleHidden(apn)
    setUndoApn(apn)
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    undoTimerRef.current = setTimeout(() => setUndoApn(null), 4000)
  }

  function handleUndo(apn: string) {
    onUndoHide(apn)
    setUndoApn(null)
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
  }

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current)
    }
  }, [])

  const sorted = [...leads].sort((a, b) => b.score - a.score)

  // When showHidden is false, filter out locally-hidden APNs
  const visibleLeads = showHidden
    ? sorted
    : sorted.filter(l => !hiddenApns.has(l.apn))

  return (
    <>
      {/* Main side panel */}
      <aside className={styles.sidePanel} aria-label="Property intelligence panel">
        {/* Panel header */}
        <div className={styles.panelHeader}>
          <span className={styles.panelHeaderLabel}>Overview</span>
          {summary && (
            <span className={styles.panelHeaderStat}>
              {summary.scored} scored · {summary.hot} hot · {summary.freshLast7 ?? 0} new (7d)
            </span>
          )}
        </div>

        {/* Filter toggle row */}
        <div className={styles.filterToggleRow}>
          <button
            className={`${styles.filterPill} ${showSavedOnly ? styles.filterPillActive : ''}`}
            onClick={onToggleSavedOnly}
            aria-pressed={showSavedOnly}
            aria-label="Show saved properties only"
          >
            ★ Saved
          </button>
          <button
            className={`${styles.filterPill} ${showHidden ? styles.filterPillActive : ''}`}
            onClick={onToggleShowHidden}
            aria-pressed={showHidden}
            aria-label="Include hidden properties"
          >
            Show hidden
          </button>
        </div>

        {/* Summary stats */}
        {summary && (
          <section className={styles.statsSection} aria-label="Summary statistics">
            <div className={styles.kpiStrip}>
              <div className={styles.kpiItem}>
                <span className={styles.kpiValue}>{summary.scored}</span>
                <span className={styles.kpiLabel}>Scored</span>
              </div>
              <div className={styles.kpiDivider} aria-hidden="true" />
              <div className={styles.kpiItem}>
                <span className={`${styles.kpiValue} ${styles.kpiValueHot}`}>{summary.hot}</span>
                <span className={styles.kpiLabel}>Hot</span>
              </div>
              <div className={styles.kpiDivider} aria-hidden="true" />
              <div className={styles.kpiItem}>
                <span className={`${styles.kpiValue} ${styles.kpiValueFresh}`}>{summary.freshLast7 ?? 0}</span>
                <span className={styles.kpiLabel}>New (7d)</span>
              </div>
            </div>

            <div className={styles.signalGrid}>
              {(
                [
                  ['trustee_sale', summary.bySignal.trustee_sale],
                  ['tax_delinquent', summary.bySignal.tax_delinquent],
                  ['code_violation', summary.bySignal.code_violation],
                  ['probate', summary.bySignal.probate],
                ] as [string, number][]
              ).map(([key, count]) => (
                <div key={key} className={styles.signalCell}>
                  <span className={`${styles.signalTag} ${SIGNAL_CSS[key]}`}>
                    {SIGNAL_LABELS[key]}
                  </span>
                  <span className={styles.signalCount}>{count}</span>
                </div>
              ))}
            </div>

            {summary.topCities.length > 0 && (
              <div className={styles.cityBar}>
                <span className={styles.cityBarLabel}>Top Cities</span>
                <div className={styles.cityList}>
                  {summary.topCities.slice(0, 4).map(({ city, n }) => (
                    <span key={city} className={styles.cityChip}>
                      {city} <span className={styles.cityCount}>{n}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Divider */}
        <div className={styles.panelDivider} aria-hidden="true" />

        {/* Undo toast — inline strip above list */}
        {undoApn && (
          <div className={styles.undoStrip} role="status" aria-live="polite">
            <span>Hidden</span>
            <button
              className={styles.undoBtn}
              onClick={() => handleUndo(undoApn)}
              aria-label="Undo hide"
            >
              Undo
            </button>
          </div>
        )}

        {/* Ranked lead list */}
        <section
          className={styles.leadList}
          aria-label="Ranked property list"
          role="list"
        >
          <div className={styles.leadListHeader}>
            <span>RANK</span>
            <span>PROPERTY</span>
            <span />
            <span>SCORE</span>
          </div>
          {visibleLeads.slice(0, 25).map((lead, i) => {
            const isActive = selectedLead?.apn === lead.apn
            const isHovered = hoveredApn === lead.apn
            const highlighted = isActive || isHovered
            const isSaved = savedApns.has(lead.apn)
            const isHidden = hiddenApns.has(lead.apn)

            return (
              <div
                key={lead.apn}
                ref={highlighted ? activeRowRef : undefined}
                className={`${styles.leadRow} ${isActive ? styles.leadRowActive : ''} ${isHovered && !isActive ? styles.leadRowHovered : ''}`}
                role="listitem"
                tabIndex={0}
                aria-label={`Rank ${i + 1}: ${lead.situsAddress}, score ${lead.score}`}
                onClick={() => onSelectLead(lead)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onSelectLead(lead)
                  }
                }}
                onMouseEnter={() => onHoverApn(lead.apn)}
                onMouseLeave={() => onHoverApn(null)}
              >
                <span className={styles.leadRank}>
                  {lead.hot && <span className={styles.hotFlame} aria-hidden="true">▲</span>}
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className={styles.leadInfo}>
                  <span className={styles.leadAddress}>{lead.situsAddress}</span>
                  <div className={styles.leadTags}>
                    {lead.signalTypes.slice(0, 2).map(sig => (
                      <span key={sig} className={`${styles.miniTag} ${SIGNAL_CSS[sig]}`}>
                        {SIGNAL_LABELS[sig] ?? sig}
                      </span>
                    ))}
                  </div>
                  {lead.latestDate && (
                    <div className={styles.leadDate}>
                      <span className={styles.leadDateText}>{formatMonD(lead.latestDate)}</span>
                      <span className={styles.leadDateChip}>{relativeAge(lead.latestDate)}</span>
                    </div>
                  )}
                </div>

                {/* Save / Hide controls */}
                <div className={styles.leadActions} onClick={e => e.stopPropagation()}>
                  <button
                    className={`${styles.saveBtn} ${isSaved ? styles.saveBtnActive : ''}`}
                    onClick={(e) => { e.stopPropagation(); onToggleSaved(lead.apn) }}
                    aria-label={isSaved ? 'Unsave property' : 'Save property'}
                    title={isSaved ? 'Unsave' : 'Save'}
                  >
                    {isSaved ? '★' : '☆'}
                  </button>
                  {showHidden && isHidden ? (
                    <button
                      className={styles.hideBtn}
                      onClick={(e) => { e.stopPropagation(); handleUndo(lead.apn) }}
                      aria-label="Unhide property"
                      title="Unhide"
                    >
                      ↩
                    </button>
                  ) : (
                    <button
                      className={styles.hideBtn}
                      onClick={(e) => { e.stopPropagation(); handleHide(lead.apn) }}
                      aria-label="Hide property"
                      title="Hide"
                    >
                      ✕
                    </button>
                  )}
                </div>

                <span className={`${styles.leadScore} ${lead.hot ? styles.leadScoreHot : ''}`}>
                  {lead.score}
                </span>
              </div>
            )
          })}
          {visibleLeads.length === 0 && (
            <div className={styles.emptyState}>
              No leads loaded
            </div>
          )}
        </section>
      </aside>

      {/* Property file drawer — slides in from right on selection */}
      {selectedLead && (
        <PropertyDrawer
          lead={selectedLead}
          savedApns={savedApns}
          onToggleSaved={onToggleSaved}
          onToggleHidden={(apn) => { handleHide(apn) }}
          onClose={() => onSelectLead(null)}
        />
      )}
    </>
  )
}

interface DrawerProps {
  lead: Lead
  savedApns: Set<string>
  onToggleSaved: (apn: string) => void
  onToggleHidden: (apn: string) => void
  onClose: () => void
}

function PropertyDrawer({ lead, savedApns, onToggleSaved, onToggleHidden, onClose }: DrawerProps) {
  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    closeBtnRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Trap focus in drawer
  useEffect(() => {
    const drawer = drawerRef.current
    if (!drawer) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const focusable = drawer!.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
    drawer.addEventListener('keydown', onKey)
    return () => drawer.removeEventListener('keydown', onKey)
  }, [])

  const mailingDiffers = lead.mailingAddress && lead.mailingAddress !== lead.situsAddress
  const components = lead.components as Record<string, number | string>
  const isSaved = savedApns.has(lead.apn)

  return (
    <div
      ref={drawerRef}
      className={styles.propertyDrawer}
      role="dialog"
      aria-modal="true"
      aria-label={`Property file: ${lead.situsAddress}`}
    >
      <div className={styles.drawerHeader}>
        <div className={styles.drawerTitleGroup}>
          <span className={styles.drawerEyebrow}>Property Detail</span>
          <span className={styles.drawerScore}>
            Score <span className={lead.hot ? styles.drawerScoreHot : ''}>{lead.score}</span>
          </span>
        </div>

        {/* Drawer-level Save / Hide buttons */}
        <div className={styles.drawerActions}>
          <button
            className={`${styles.saveBtn} ${isSaved ? styles.saveBtnActive : ''}`}
            onClick={() => onToggleSaved(lead.apn)}
            aria-label={isSaved ? 'Unsave property' : 'Save property'}
            title={isSaved ? 'Unsave' : 'Save'}
          >
            {isSaved ? '★' : '☆'}
          </button>
          <button
            className={styles.hideBtn}
            onClick={() => { onToggleHidden(lead.apn); onClose() }}
            aria-label="Hide property"
            title="Hide"
          >
            ✕
          </button>
          <button
            ref={closeBtnRef}
            className={styles.drawerClose}
            onClick={onClose}
            aria-label="Close property file"
          >
            ✕
          </button>
        </div>
      </div>

      <div className={styles.drawerBody}>
        {/* Owner */}
        <div className={styles.drawerField}>
          <span className={styles.drawerFieldLabel}>Owner</span>
          <span className={styles.drawerFieldValue}>
            {lead.ownerName}
            {lead.absentee && (
              <span className={styles.absenteeBadge} title="Absentee owner">ABSENTEE</span>
            )}
          </span>
        </div>

        {/* Situs address */}
        <div className={styles.drawerField}>
          <span className={styles.drawerFieldLabel}>Property</span>
          <span className={styles.drawerFieldValue}>
            {lead.situsAddress}<br />
            {lead.situsCity}, AZ
          </span>
        </div>

        {/* Mailing address (only if different) */}
        {mailingDiffers && (
          <div className={styles.drawerField}>
            <span className={styles.drawerFieldLabel}>Mailing</span>
            <span className={styles.drawerFieldValue}>{lead.mailingAddress}</span>
          </div>
        )}

        {/* APN */}
        <div className={styles.drawerField}>
          <span className={styles.drawerFieldLabel}>APN</span>
          <span className={`${styles.drawerFieldValue} ${styles.monoValue}`}>{lead.apn}</span>
        </div>

        {/* Signals */}
        <div className={styles.drawerField}>
          <span className={styles.drawerFieldLabel}>Signals</span>
          <div className={styles.drawerTags}>
            {lead.signalTypes.map(sig => (
              <span key={sig} className={`${styles.signalTag} ${SIGNAL_CSS[sig]}`}>
                {SIGNAL_LABELS[sig] ?? sig}
              </span>
            ))}
          </div>
        </div>

        {/* Signal timeline */}
        {lead.signals && lead.signals.length > 0 && (
          <div className={styles.drawerField}>
            <span className={styles.drawerFieldLabel}>Signal timeline</span>
            <div className={styles.signalTimeline}>
              {lead.signals.map((sig, i) => {
                const SIGNAL_VERBS: Record<string, string> = {
                  trustee_sale: 'Trustee Sale — recorded',
                  probate: 'Probate — filed',
                  code_violation: 'Code Violation — opened',
                  tax_delinquent: 'Tax Delinquent',
                }
                const dateStr = sig.type === 'tax_delinquent'
                  ? (sig.observedDate ? `as of ${formatSignalDate(sig.observedDate)}` : null)
                  : (sig.eventDate ? formatSignalDate(sig.eventDate) : null)
                const verb = SIGNAL_VERBS[sig.type] ?? sig.type
                return (
                  <div key={i} className={styles.signalTimelineRow}>
                    <span className={styles.signalTimelineVerb}>{verb}</span>
                    {dateStr && <span className={styles.signalTimelineDate}>{dateStr}</span>}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Score breakdown */}
        {lead.scoreBreakdown && lead.scoreBreakdown.length > 0 && (
          <div className={styles.drawerField}>
            <span className={styles.drawerFieldLabel}>Score breakdown</span>
            <div className={styles.componentsGrid}>
              {lead.scoreBreakdown.map((entry, i) => (
                <div key={i} className={styles.componentRow}>
                  <span className={styles.componentKey}>{entry.label}</span>
                  <span className={`${styles.componentVal} ${styles.monoValue} ${styles.scorePoints}`}>
                    +{entry.points}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Score components */}
        {Object.keys(components).length > 0 && (
          <div className={styles.drawerField}>
            <span className={styles.drawerFieldLabel}>Why it scored</span>
            <div className={styles.componentsGrid}>
              {Object.entries(components).map(([key, val]) => (
                <div key={key} className={styles.componentRow}>
                  <span className={styles.componentKey}>
                    {key.replace(/_/g, ' ')}
                  </span>
                  <span className={`${styles.componentVal} ${styles.monoValue}`}>
                    {String(val)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
