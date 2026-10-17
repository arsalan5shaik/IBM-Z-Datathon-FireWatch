import { useEffect, useRef, useState } from 'react'
import { AttributionControl, Map, NavigationControl, Popup, ScaleControl, setWorkerUrl } from 'maplibre-gl'
import type { GeoJSONSource, LngLatBoundsLike } from 'maplibre-gl'
import type { FeatureCollection, Point } from 'geojson'
import { loadHotspots, loadSnapshots } from '../api/client'
import type { HotspotCollection, HotspotProperties, Snapshot } from '../types/hotspots'
import { FRP_BANDS, MISSING_FRP_COLOR } from '../types/frp'
import HotspotControls from './HotspotControls'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

// Vite must bundle the MapLibre v6 worker separately for GeoJSON processing.
setWorkerUrl(workerUrl)

const CALIFORNIA_BOUNDS: LngLatBoundsLike = [[-124.5, 32.5], [-114.1, 42.0]]
const SOURCE_ID = 'historical-hotspots'
const EMPTY_POINTS: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] }

function observationDetails(properties: HotspotProperties, coordinates: number[], sourceFile: string) {
  // Use textContent rather than HTML interpolation for untrusted CSV/API values.
  const content = document.createElement('div')
  content.className = 'hotspot-popup'
  const heading = document.createElement('h3')
  heading.textContent = 'Historical satellite observation'
  content.append(heading)
  const list = document.createElement('dl')
  function row(label: string, value: unknown, unit = '') {
    const term = document.createElement('dt')
    term.textContent = label
    const detail = document.createElement('dd')
    detail.textContent = value === null || value === undefined || value === '' ? 'Unavailable' : `${value}${unit}`
    list.append(term, detail)
  }
  const confidenceNames: Record<string, string> = { l: 'Low (l)', n: 'Nominal (n)', h: 'High (h)' }
  const typeNames: Record<string, string> = { '0': 'Presumed vegetation fire (0)', '1': 'Active volcano (1)', '2': 'Other static land source (2)', '3': 'Offshore (3)' }
  row('Observed (UTC)', properties.detected_at.replace('T', ' ').replace('Z', ' UTC'))
  row('Latitude', coordinates[1].toFixed(5))
  row('Longitude', coordinates[0].toFixed(5))
  row('Satellite', properties.satellite === 'N' ? 'Suomi NPP (N)' : properties.satellite)
  row('Instrument', properties.instrument)
  row('FRP', properties.frp_mw, ' MW')
  row('Confidence class', confidenceNames[properties.confidence ?? ''] ?? properties.confidence)
  row('I4 brightness temperature', properties.bright_ti4_k, ' K')
  row('I5 brightness temperature', properties.bright_ti5_k, ' K')
  row('Scan / track footprint', properties.scan_km != null && properties.track_km != null ? `${properties.scan_km} / ${properties.track_km} km` : null)
  row('Day / night', properties.daynight === 'D' ? 'Day (D)' : properties.daynight === 'N' ? 'Night (N)' : properties.daynight)
  row('Inferred source type', typeNames[properties.source_type ?? ''] ?? properties.source_type)
  row('Product version', properties.version)
  row('CSV source', sourceFile)
  row('CSV line (header = 1)', properties.source_row)
  content.append(list)
  const notice = document.createElement('p')
  notice.textContent = 'Thermal detection, not a confirmed wildfire, incident count, or fire perimeter. FRP is not a risk probability.'
  content.append(notice)
  return content
}

export default function FireMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const popupRef = useRef<Popup | null>(null)
  const dataRef = useRef<HotspotCollection | null>(null)
  const interactionsRef = useRef({ visible: true, opacity: 0.85 })
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [view, setView] = useState('California overview')
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [hotspots, setHotspots] = useState<HotspotCollection | null>(null)
  const [dataError, setDataError] = useState('')
  const [visible, setVisible] = useState(true)
  const [opacity, setOpacity] = useState(0.85)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    loadSnapshots(controller.signal).then((items) => {
      if (controller.signal.aborted) return
      setSnapshots(items)
      setSelectedDate((previous) => items.some((item) => item.date === previous) ? previous : items[items.length - 1].date)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setDataError(error instanceof Error ? error.message : 'Could not load historical dates.')
    })
    return () => controller.abort()
  }, [reloadToken])

  useEffect(() => {
    const snapshot = snapshots.find((item) => item.date === selectedDate)
    if (!snapshot) return
    const controller = new AbortController()
    loadHotspots(snapshot, controller.signal).then((data) => {
      if (!controller.signal.aborted) setHotspots(data)
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setDataError(error instanceof Error ? error.message : 'Could not load historical observations.')
    })
    return () => controller.abort()
  }, [selectedDate, snapshots])

  useEffect(() => {
    dataRef.current = hotspots
    const source = mapRef.current?.getSource<GeoJSONSource>(SOURCE_ID)
    source?.setData(hotspots ?? EMPTY_POINTS)
    popupRef.current?.remove()
  }, [hotspots, status])

  useEffect(() => {
    interactionsRef.current = { visible, opacity }
    const map = mapRef.current
    if (!map?.getLayer(SOURCE_ID)) return
    map.setLayoutProperty(SOURCE_ID, 'visibility', visible ? 'visible' : 'none')
    map.setPaintProperty(SOURCE_ID, 'circle-opacity', opacity)
    map.setPaintProperty(SOURCE_ID, 'circle-stroke-opacity', opacity)
    if (!visible || opacity === 0) {
      popupRef.current?.remove()
      map.getCanvas().style.cursor = ''
    }
  }, [visible, opacity, status])

  useEffect(() => {
    if (!containerRef.current) return
    let map: Map
    try {
      map = new Map({
        container: containerRef.current,
        // Coordinates throughout this app are [longitude, latitude].
        center: [-119.3, 37.2],
        bounds: CALIFORNIA_BOUNDS,
        fitBoundsOptions: { padding: 36, duration: 0 },
        maxZoom: 18,
        renderWorldCopies: false,
        attributionControl: false,
        style: {
          version: 8,
          sources: {
            openstreetmap: {
              type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256, maxzoom: 19,
              attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            },
          },
          layers: [{ id: 'basemap', type: 'raster', source: 'openstreetmap' }],
        },
      })
    } catch {
      // oxlint-disable-next-line react/set-state-in-effect -- Report an external WebGL initialization failure.
      setStatus('error')
      return
    }
    mapRef.current = map
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left')
    map.addControl(new AttributionControl({ compact: false }), 'bottom-right')

    const updateView = () => {
      const center = map.getCenter()
      setView(`${center.lat.toFixed(3)}, ${center.lng.toFixed(3)} | Zoom ${map.getZoom().toFixed(1)}`)
    }
    map.on('load', () => {
      // MapLibre draws all points with one GPU layer, not thousands of DOM nodes.
      map.addSource(SOURCE_ID, { type: 'geojson', data: dataRef.current ?? EMPTY_POINTS })
      map.addLayer({
        id: SOURCE_ID, type: 'circle', source: SOURCE_ID,
        layout: { visibility: interactionsRef.current.visible ? 'visible' : 'none' },
        paint: {
          'circle-color': ['case', ['==', ['get', 'frp_mw'], null], MISSING_FRP_COLOR,
            ['step', ['get', 'frp_mw'], FRP_BANDS[0].color,
              FRP_BANDS[1].minimum, FRP_BANDS[1].color,
              FRP_BANDS[2].minimum, FRP_BANDS[2].color,
              FRP_BANDS[3].minimum, FRP_BANDS[3].color]],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 8, 5, 14, 7],
          'circle-opacity': interactionsRef.current.opacity,
          'circle-stroke-color': '#39252a',
          'circle-stroke-width': 0.6,
          'circle-stroke-opacity': interactionsRef.current.opacity,
        },
      })
      setStatus('ready')
      updateView()
    })
    map.on('click', SOURCE_ID, (event) => {
      const feature = event.features?.[0]
      const data = dataRef.current
      if (!feature || feature.geometry.type !== 'Point' || !data || !interactionsRef.current.visible || interactionsRef.current.opacity === 0) return
      popupRef.current?.remove()
      popupRef.current = new Popup({ maxWidth: '340px', focusAfterOpen: true })
        .setLngLat(feature.geometry.coordinates as [number, number])
        .setDOMContent(observationDetails(feature.properties as HotspotProperties, feature.geometry.coordinates, data.metadata.source_file))
        .addTo(map)
    })
    map.on('mouseenter', SOURCE_ID, () => {
      if (interactionsRef.current.visible && interactionsRef.current.opacity > 0) map.getCanvas().style.cursor = 'pointer'
    })
    map.on('mouseleave', SOURCE_ID, () => { map.getCanvas().style.cursor = '' })
    map.on('moveend', updateView)
    map.on('error', () => setStatus('error'))
    // StrictMode checks setup/cleanup twice. Abort fetches above; remove WebGL here.
    return () => {
      popupRef.current?.remove()
      map.remove()
      mapRef.current = null
    }
  }, [])

  function clearData() {
    setHotspots(null)
    setDataError('')
    popupRef.current?.remove()
    mapRef.current?.getSource<GeoJSONSource>(SOURCE_ID)?.setData(EMPTY_POINTS)
  }
  function changeDate(date: string) {
    clearData()
    setSelectedDate(date)
  }
  function retryData() {
    clearData()
    setReloadToken((token) => token + 1)
  }
  function resetView() {
    mapRef.current?.fitBounds(CALIFORNIA_BOUNDS, { padding: 36, bearing: 0, pitch: 0, duration: 0 })
  }
  const dataMessage = dataError || (hotspots
    ? `${hotspots.features.length.toLocaleString()} observations loaded for ${selectedDate} UTC${visible ? '' : ' (layer hidden)'}. CSV: ${hotspots.metadata.source_file}. Original download time unknown.`
    : `Loading historical observations${selectedDate ? ` for ${selectedDate}` : ''}...`)

  return (
    <section className="map-section" aria-label="California map explorer">
      <div className="map-toolbar">
        <div>
          <h2>Explore California</h2>
          <p id="map-help">Drag to pan. Use + / - or scroll to zoom. Click a colored observation for details.</p>
        </div>
        <button type="button" onClick={resetView} disabled={status === 'loading'}>Reset California view</button>
      </div>
      <HotspotControls snapshots={snapshots} selectedDate={selectedDate} onDateChange={changeDate}
        visible={visible} onVisibilityChange={setVisible} opacity={opacity} onOpacityChange={setOpacity}
        message={dataMessage} error={Boolean(dataError)} onRetry={retryData} />
      <div className="map-frame">
        <div ref={containerRef} className="fire-map" aria-label="Interactive California map with historical observations" aria-describedby="map-help" />
        {status !== 'ready' && <p className={`map-message ${status === 'error' ? 'map-message-error' : ''}`} role="status">
          {status === 'loading' ? 'Loading basemap...' : 'The map could not load completely. Check your internet connection and browser WebGL support, then reload.'}
        </p>}
      </div>
      <div className="map-footer">
        <span>{view}</span><span>Historical VIIRS / not live / risk model not connected</span>
      </div>
    </section>
  )
}

