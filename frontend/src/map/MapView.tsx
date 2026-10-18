import { mountHistoricalERCLayer } from './ercHistorical';
import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, Marker, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CA_BOUNDS, MAX_BOUNDS } from '../config';
import { getState, setState } from '../state/store';
import { addIcons } from './icons';
import { bindInteractions } from './interactions';
import { addOverlays } from './layers';
import { setMap } from './mapRef';
import { FireMarkers } from './markers';
import { buildStyle } from './style';
import { startSync } from './sync';
import { readInitialCamera } from '../state/urlState';

setWorkerUrl(workerUrl);

function supportsWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function MapView() {
  const container = useRef<HTMLDivElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let map: MapLibreMap | null = null;
    const cleanups: (() => void)[] = [];

    (async () => {
      if (!supportsWebGL()) {
        setState((s) => ({ map: { ...s.map, webglError: true } }));
        return;
      }
      const { style, fallback } = await buildStyle();
      if (disposed || !container.current) return;
      const camera = readInitialCamera();
      const prefs = getState();
      map = new MapLibreMap({
        container: container.current,
        style,
        ...(camera
          ? { center: camera.center, zoom: camera.zoom, bearing: camera.bearing, pitch: prefs.view === '3d' ? camera.pitch : 0 }
          : { bounds: CA_BOUNDS, fitBoundsOptions: { padding: { top: 90, bottom: 150, left: 80, right: 40 } } }),
        maxBounds: MAX_BOUNDS,
        minZoom: 4,
        maxZoom: 18,
        maxPitch: prefs.view === '3d' ? 70 : 0,
        attributionControl: { compact: true },
        renderWorldCopies: false,
        canvasContextAttributes: { antialias: true },
        fadeDuration: 150,
      });
      setMap(map);
      if (import.meta.env.DEV) (window as unknown as { __fwMap: MapLibreMap }).__fwMap = map;
      map.touchZoomRotate.disableRotation();
      map.keyboard.enable();

      const markers = new FireMarkers(map);
      map.on('load', () => {
        if (disposed || !map) return;
        addIcons(map);

        // Actual verified ERC-G predictions, refreshed for the selected lead day.
        const v6Markers = new Map<string, Marker>();
        let v6Active = true;
        let v6LeadDay = 1;
        let v6Request = 0;

        // FireWatch fire-risk palette, reused as a RELATIVE ERC-G scale.
        // The color is not an official danger rating or ignition probability.
        const v6Ramp = ['#fff5e6', '#dfb4d4', '#b971af', '#7a1c8c'];
        function v6Color(value: number, lo: number, hi: number) {
          const ratio = hi > lo ? Math.max(0, Math.min(1, (value - lo) / (hi - lo))) : 0.5;
          const step = ratio * (v6Ramp.length - 1);
          const i = Math.min(Math.floor(step), v6Ramp.length - 2);
          const fraction = step - i;
          const a = v6Ramp[i].slice(1);
          const b = v6Ramp[i + 1].slice(1);
          const rgb = [0, 2, 4].map((k) => Math.round(
            parseInt(a.slice(k, k + 2), 16) * (1 - fraction) +
            parseInt(b.slice(k, k + 2), 16) * fraction
          ));
          return {
            background: `rgb(${rgb.join(',')})`,
            text: ratio < 0.46 ? '#192333' : '#ffffff',
          };
        }

        async function refreshV6Markers() {
          const request = ++v6Request;
          try {
            const response = await fetch(`/api/v1/erc/points?lead_day=${v6LeadDay}`, {
              cache: 'no-store',
            });
            if (!response.ok) return;
            const data = await response.json() as {
              min_score: number | null;
              max_score: number | null;
              points: {
                cell_id: string;
                location_name: string;
                latitude: number;
                longitude: number;
                forecast_days: number;
                valid_date: string;
                erc_g_display: number;
              }[];
            };
            if (!v6Active || request !== v6Request || !map) return;
            for (const marker of v6Markers.values()) marker.remove();
            v6Markers.clear();
            const lo = data.min_score ?? 0;
            const hi = data.max_score ?? lo;
            for (const point of data.points) {
              const button = document.createElement('button');
              button.type = 'button';
              button.title = `${point.location_name}: ${point.erc_g_display.toFixed(1)} ERC-G` +
                ` on ${point.valid_date} (relative color, not fire probability)`;
              button.setAttribute('aria-label', `View ${point.location_name} ERC-G forecast`);
              button.textContent = point.erc_g_display.toFixed(0);
              const palette = v6Color(point.erc_g_display, lo, hi);
              Object.assign(button.style, {
                width: '36px', height: '36px',
                background: palette.background, color: palette.text,
                border: '1.5px solid rgba(255,255,255,.92)', borderRadius: '50%',
                opacity: '0.89', backdropFilter: 'blur(4px)',
                fontWeight: '800', fontSize: '11px', cursor: 'pointer',
                boxShadow: '0 3px 12px #000a',
              });
              button.addEventListener('click', (event) => {
                event.stopPropagation();
                window.dispatchEvent(new CustomEvent('firewatch:open-v6', {
                  detail: point.cell_id,
                }));
              });
              const marker = new Marker({ element: button, anchor: 'center' })
                .setLngLat([point.longitude, point.latitude]).addTo(map);
              v6Markers.set(point.cell_id, marker);
            }
          } catch (error) {
            console.warn('V6 map points unavailable', error);
          }
        }

        const onV6Day = (event: Event) => {
          const day = (event as CustomEvent<number>).detail;
          if (!Number.isInteger(day) || day < 1 || day > 7) return;
          v6LeadDay = day;
          void refreshV6Markers();
        };
        window.addEventListener('firewatch:v6-day', onV6Day);
        void refreshV6Markers();
        const v6Timer = window.setInterval(refreshV6Markers, 60_000);
        cleanups.push(() => {
          v6Active = false;
          window.clearInterval(v6Timer);
          window.removeEventListener('firewatch:v6-day', onV6Day);
          for (const marker of v6Markers.values()) marker.remove();
          v6Markers.clear();
        });

        addOverlays(map, getState().riskOpacity);
        cleanups.push(mountHistoricalERCLayer(map));
        cleanups.push(startSync(map, markers));
        cleanups.push(bindInteractions(map, tooltip.current!));
        cleanups.push(() => markers.destroy());
        setState((s) => ({ map: { ...s.map, ready: true, styleFallback: fallback } }));
      });
      let demErrors = 0;
      map.on('error', (e: unknown) => {
        const { sourceId, error } = e as { sourceId?: string; error?: Error };
        if (sourceId?.includes('dem')) {
          if (++demErrors === 3) setState((s) => ({ map: { ...s.map, terrainError: true } }));
          return;
        }
        console.warn('[map]', sourceId ?? '', error?.message ?? e);
      });
      map.on('styleimagemissing', () => undefined);
    })().catch(() => setState((s) => ({ map: { ...s.map, webglError: true } })));

    return () => {
      disposed = true;
      cleanups.forEach((c) => c());
      setMap(null);
      map?.remove();
    };
  }, []);

  return (
    <div className="map-wrap">
      <div ref={container} className="map" role="region" aria-label="Map of California wildfire activity and forecast risk" />
      <div ref={tooltip} className="map-tooltip" hidden role="tooltip" />
    </div>
  );
}
