'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { Lead } from './page'
import styles from './atlas.module.css'

// maplibre-gl is SSR-incompatible; this file is only loaded client-side via dynamic()
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

const CITY_CENTROIDS: Record<string, [number, number]> = {
  phoenix:     [33.448, -112.074],
  mesa:        [33.415, -111.831],
  glendale:    [33.539, -112.186],
  scottsdale:  [33.494, -111.926],
  tempe:       [33.425, -111.940],
  chandler:    [33.306, -111.841],
  gilbert:     [33.353, -111.789],
  goodyear:    [33.435, -112.358],
  tolleson:    [33.450, -112.259],
  avondale:    [33.436, -112.349],
  peoria:      [33.580, -112.237],
  surprise:    [33.629, -112.368],
}

const DEFAULT_CENTROID: [number, number] = [33.448, -112.074]

function cityKey(city: string): string {
  return city.toLowerCase().replace(/\s+/g, '')
}

function fallbackCoords(city: string): [number, number] {
  const key = cityKey(city)
  const base = CITY_CENTROIDS[key] ?? DEFAULT_CENTROID
  // ±0.02 degree jitter
  const jitter = () => (Math.random() - 0.5) * 0.04
  return [base[0] + jitter(), base[1] + jitter()]
}

async function geocodeAddress(address: string, city: string): Promise<[number, number] | null> {
  try {
    const q = encodeURIComponent(`${address}, ${city}, AZ, USA`)
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${q}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'motivated-sellers-proto' },
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data && data.length > 0) {
      return [parseFloat(data[0].lat), parseFloat(data[0].lon)]
    }
    return null
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Score → pin size (px, diameter)
function pinSize(score: number): number {
  const clamped = Math.max(0, Math.min(100, score))
  return 10 + Math.round((clamped / 100) * 18) // 10–28px
}

function makePinSvg(hot: boolean, size: number, highlighted: boolean): string {
  const color = hot ? '#FF5722' : '#3DDC97'
  const glowColor = hot ? 'rgba(255, 87, 34, 0.5)' : 'rgba(61, 220, 151, 0.4)'
  const borderColor = highlighted ? '#D9C9A8' : color
  const borderWidth = highlighted ? 3 : 2
  const r = size / 2
  const viewSize = size + 20 // padding for glow
  const cx = viewSize / 2
  const cy = viewSize / 2

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${viewSize}" height="${viewSize}" viewBox="0 0 ${viewSize} ${viewSize}">
    <defs>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${r + 5}" fill="${glowColor}" filter="url(#glow)" />
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="${borderColor}" stroke-width="${borderWidth}" />
  </svg>`
}

interface Props {
  leads: Lead[]
  selectedLead: Lead | null
  hoveredApn: string | null
  hiddenApns: Set<string>
  onSelectLead: (lead: Lead) => void
  onHoverApn: (apn: string | null) => void
}

export default function MapView({ leads, selectedLead, hoveredApn, hiddenApns, onSelectLead, onHoverApn }: Props) {
  const mapContainerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map())
  const [coords, setCoords] = useState<{ lat: number; lng: number }>({ lat: 33.45, lng: -112.07 })
  const [pinPositions, setPinPositions] = useState<Map<string, [number, number]>>(new Map())
  const geocodingRef = useRef(false)

  // Initialize map
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [-112.07, 33.45],
      zoom: 9,
    })

    map.on('move', () => {
      const c = map.getCenter()
      setCoords({ lat: parseFloat(c.lat.toFixed(5)), lng: parseFloat(c.lng.toFixed(5)) })
    })

    mapRef.current = map

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Geocode top 25 leads with throttle + fallback
  useEffect(() => {
    if (!leads.length || geocodingRef.current) return
    geocodingRef.current = true

    const top25 = leads.slice(0, 25)
    const positions = new Map<string, [number, number]>()

    // Immediately set fallback coords for all
    for (const lead of top25) {
      positions.set(lead.apn, fallbackCoords(lead.situsCity))
    }
    setPinPositions(new Map(positions))

    // Then geocode and update
    ;(async () => {
      for (const lead of top25) {
        const result = await geocodeAddress(lead.situsAddress, lead.situsCity)
        if (result) {
          positions.set(lead.apn, result)
          setPinPositions(new Map(positions))
        }
        await sleep(1100) // ≥1s between Nominatim requests
      }
    })()
  }, [leads])

  // Place/update markers when pinPositions change
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    // Remove markers for leads no longer in pinPositions OR that are now hidden
    for (const [apn, marker] of markersRef.current) {
      if (!pinPositions.has(apn) || hiddenApns.has(apn)) {
        marker.remove()
        markersRef.current.delete(apn)
      }
    }

    for (const lead of leads.slice(0, 25)) {
      // Skip hidden leads — no pin
      if (hiddenApns.has(lead.apn)) continue

      const pos = pinPositions.get(lead.apn)
      if (!pos) continue

      const [lat, lng] = pos
      const isSelected = selectedLead?.apn === lead.apn
      const isHovered = hoveredApn === lead.apn
      const highlighted = isSelected || isHovered
      const size = pinSize(lead.score)
      const svgString = makePinSvg(lead.hot, size, highlighted)

      const existing = markersRef.current.get(lead.apn)
      if (existing) {
        // Update marker element
        const el = existing.getElement()
        el.innerHTML = svgString
        el.style.width = `${size + 20}px`
        el.style.height = `${size + 20}px`
        existing.setLngLat([lng, lat])
      } else {
        // Create marker element
        const el = document.createElement('div')
        el.innerHTML = svgString
        el.style.width = `${size + 20}px`
        el.style.height = `${size + 20}px`
        el.style.cursor = 'pointer'
        el.title = `${lead.situsAddress} — Score: ${lead.score}`
        if (lead.hot) {
          el.classList.add(styles.pinHot)
        }

        el.addEventListener('mouseenter', () => onHoverApn(lead.apn))
        el.addEventListener('mouseleave', () => onHoverApn(null))
        el.addEventListener('click', () => {
          onSelectLead(lead)
          mapRef.current?.flyTo({ center: [lng, lat], zoom: 14, speed: 0.8 })
        })
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelectLead(lead)
            mapRef.current?.flyTo({ center: [lng, lat], zoom: 14, speed: 0.8 })
          }
        })
        el.setAttribute('tabindex', '0')
        el.setAttribute('role', 'button')
        el.setAttribute('aria-label', `Property: ${lead.situsAddress}, Score: ${lead.score}`)

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([lng, lat])
          .addTo(map)
        markersRef.current.set(lead.apn, marker)
      }
    }
  }, [leads, pinPositions, selectedLead, hoveredApn, hiddenApns, onSelectLead, onHoverApn])

  // Fly to selected lead
  useEffect(() => {
    if (!selectedLead || !mapRef.current) return
    const pos = pinPositions.get(selectedLead.apn)
    if (pos) {
      const [lat, lng] = pos
      mapRef.current.flyTo({ center: [lng, lat], zoom: 14, speed: 0.8 })
    }
  }, [selectedLead, pinPositions])

  return (
    <div className={styles.mapInner}>
      <div ref={mapContainerRef} className={styles.mapCanvas} />
      {/* Vignette overlay */}
      <div className={styles.vignette} aria-hidden="true" />
      {/* Coordinate readout */}
      <div className={styles.coordReadout} aria-live="polite" aria-label="Map center coordinates">
        <span className={styles.coordText}>
          {coords.lat.toFixed(5)}° N &nbsp; {Math.abs(coords.lng).toFixed(5)}° W
        </span>
      </div>
    </div>
  )
}
