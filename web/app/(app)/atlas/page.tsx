'use client'

import localFont from 'next/font/local'
import { useCallback, useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import styles from './atlas.module.css'
import SidePanel from './SidePanel'
import { setAction } from '@/lib/actions'

const spaceGrotesk = localFont({
  src: '../../fonts/SpaceGrotesk-Variable.woff2',
  weight: '300 700',
  variable: '--font-display',
  display: 'swap',
})
const spaceMono = localFont({
  src: [
    { path: '../../fonts/SpaceMono-400.woff2', weight: '400', style: 'normal' },
    { path: '../../fonts/SpaceMono-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
})

const MapView = dynamic(() => import('./MapView'), { ssr: false })

export interface Lead {
  apn: string
  score: number
  hot: boolean
  signalTypes: string[]
  components: Record<string, unknown>
  ownerName: string
  situsAddress: string
  situsCity: string
  mailingAddress: string
  absentee: boolean
  latestDate: string | null
  signals: Array<{ type: string; source: string; eventDate: string | null; observedDate: string | null }>
  scoreBreakdown: Array<{ label: string; points: number }>
  saved: boolean
}

export interface Summary {
  scored: number
  hot: number
  freshLast7: number
  freshLast30: number
  bySignal: {
    tax_delinquent: number
    code_violation: number
    trustee_sale: number
    probate: number
  }
  topCities: Array<{ city: string; n: number }>
}

export default function AtlasPage() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [hoveredApn, setHoveredApn] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Save/Hide state lifted here
  const [savedApns, setSavedApns] = useState<Set<string>>(new Set())
  const [hiddenApns, setHiddenApns] = useState<Set<string>>(new Set())

  // Filter toggle state
  const [showSavedOnly, setShowSavedOnly] = useState(false)
  const [showHidden, setShowHidden] = useState(false)

  const fetchLeads = useCallback(async (savedOnly: boolean, includeHidden: boolean) => {
    try {
      const params = new URLSearchParams({ limit: '50' })
      if (savedOnly) params.set('savedOnly', '1')
      if (includeHidden) params.set('includeHidden', '1')

      const [leadsRes, summaryRes] = await Promise.all([
        fetch(`/api/leads?${params.toString()}`),
        fetch('/api/summary'),
      ])
      const leadsData = await leadsRes.json()
      const summaryData = await summaryRes.json()
      const rawLeads: Lead[] = Array.isArray(leadsData) ? leadsData : (leadsData.leads ?? [])
      setLeads(rawLeads)
      setSummary(summaryData)

      // Seed savedApns from API data on each fetch
      const newSaved = new Set<string>()
      for (const lead of rawLeads) {
        if (lead.saved) newSaved.add(lead.apn)
      }
      setSavedApns(newSaved)
    } catch (err) {
      console.error('Failed to fetch atlas data:', err)
      setLeads([])
      setSummary(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load
  useEffect(() => {
    fetchLeads(false, false)
  }, [fetchLeads])

  // Refetch when filter toggles change (skip initial mount — handled above)
  const [didMount, setDidMount] = useState(false)
  useEffect(() => {
    if (!didMount) { setDidMount(true); return }
    fetchLeads(showSavedOnly, showHidden)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSavedOnly, showHidden])

  const onToggleSaved = useCallback((apn: string) => {
    setSavedApns(prev => {
      const next = new Set(prev)
      const newVal = !prev.has(apn)
      if (newVal) next.add(apn)
      else next.delete(apn)
      // Fire-and-forget; errors logged in console
      setAction(apn, 'saved', newVal).catch(err => console.error('setAction saved failed:', err))
      return next
    })
  }, [])

  const onToggleHidden = useCallback((apn: string) => {
    setHiddenApns(prev => {
      const next = new Set(prev)
      next.add(apn)
      setAction(apn, 'hidden', true).catch(err => console.error('setAction hidden failed:', err))
      return next
    })
    // Close drawer if the hidden lead is currently selected
    setSelectedLead(prev => (prev?.apn === apn ? null : prev))
  }, [])

  const onUndoHide = useCallback((apn: string) => {
    setHiddenApns(prev => {
      const next = new Set(prev)
      next.delete(apn)
      setAction(apn, 'hidden', false).catch(err => console.error('setAction unhide failed:', err))
      return next
    })
  }, [])

  return (
    <div className={`${styles.root} ${spaceGrotesk.variable} ${spaceMono.variable}`}>
      {/* Map fills entire viewport */}
      <div className={styles.mapContainer}>
        {!loading && (
          <MapView
            leads={leads}
            selectedLead={selectedLead}
            hoveredApn={hoveredApn}
            hiddenApns={hiddenApns}
            onSelectLead={setSelectedLead}
            onHoverApn={setHoveredApn}
          />
        )}
        {loading && (
          <div className={styles.mapLoading}>
            <span className={styles.loadingPulse} aria-hidden="true" />
            <span className={styles.loadingText}>Initializing atlas…</span>
          </div>
        )}
      </div>

      {/* Title overlay — top-left, over the map */}
      <div className={styles.titleOverlay} aria-label="Page title">
        <span className={styles.titleLabel}>Maricopa County</span>
      </div>

      {/* Side panel — overlays right side */}
      <SidePanel
        leads={leads}
        summary={summary}
        selectedLead={selectedLead}
        hoveredApn={hoveredApn}
        savedApns={savedApns}
        hiddenApns={hiddenApns}
        showSavedOnly={showSavedOnly}
        showHidden={showHidden}
        onSelectLead={setSelectedLead}
        onHoverApn={setHoveredApn}
        onToggleSaved={onToggleSaved}
        onToggleHidden={onToggleHidden}
        onUndoHide={onUndoHide}
        onToggleSavedOnly={() => setShowSavedOnly(v => !v)}
        onToggleShowHidden={() => setShowHidden(v => !v)}
      />
    </div>
  )
}
