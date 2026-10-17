import { useEffect, useRef, useState } from 'react'
import { AttributionControl, Map, NavigationControl, ScaleControl } from 'maplibre-gl'
import type { LngLatBoundsLike } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

const CALIFORNIA_BOUNDS: LngLatBoundsLike = [
  [-124.5, 32.5],
  [-114.1, 42.0],
]

export default function FireMap() {
  // Refs keep the HTML container and MapLibre instance between React renders.
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [view, setView] = useState('California overview')

  useEffect(() => {
    if (!containerRef.current) return

    let map: Map
    try {
      map = new Map({
        container: containerRef.current,
        // MapLibre and GeoJSON use [longitude, latitude], in that order.
        center: [-119.3, 37.2],
        bounds: CALIFORNIA_BOUNDS,
        fitBoundsOptions: { padding: 36, duration: 0 },
        maxZoom: 18,
        renderWorldCopies: false,
        attributionControl: false,
        // Public basemap tiles only; no NASA data or secret API keys are used.
        style: {
          version: 8,
          sources: {
            openstreetmap: {
              type: 'raster',
              tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
              tileSize: 256,
              maxzoom: 19,
              attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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
      setView(
        `${center.lat.toFixed(3)}, ${center.lng.toFixed(3)} | Zoom ${map.getZoom().toFixed(1)}`,
      )
    }

    map.on('load', () => {
      setStatus('ready')
      updateView()
    })
    map.on('moveend', updateView)
    map.on('error', () => setStatus('error'))

    // React StrictMode checks setup/cleanup twice in development.
    // Removing the map prevents duplicate canvases, listeners, and workers.
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  function resetView() {
    mapRef.current?.fitBounds(CALIFORNIA_BOUNDS, {
      padding: 36,
      bearing: 0,
      pitch: 0,
      duration: 0,
    })
  }

  return (
    <section className="map-section" aria-label="California map explorer">
      <div className="map-toolbar">
        <div>
          <h2>Explore California</h2>
          <p id="map-help">Drag to pan. Use + / - or scroll to zoom. Keyboard arrows also pan the map.</p>
        </div>
        <button type="button" onClick={resetView} disabled={status === 'loading'}>
          Reset California view
        </button>
      </div>
      <div className="map-frame">
        <div
          ref={containerRef}
          className="fire-map"
          aria-label="Interactive California basemap"
          aria-describedby="map-help"
        />
        {status !== 'ready' && (
          <p className={`map-message ${status === 'error' ? 'map-message-error' : ''}`} role="status">
            {status === 'loading'
              ? 'Loading basemap...'
              : 'The map could not load completely. Check your internet connection and browser WebGL support, then reload.'}
          </p>
        )}
      </div>
      <div className="map-footer">
        <span>{view}</span>
        <span>Basemap only | Fire and risk layers are not connected</span>
      </div>
    </section>
  )
}

