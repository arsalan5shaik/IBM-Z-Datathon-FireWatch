import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
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
import { MOTION, motionOn } from './motion';
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
      const intro = !camera && motionOn();
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
      // Two-finger rotate is allowed; small rotations snap back to north (bearingSnap).
      map.touchZoomRotate.enableRotation();
      map.keyboard.enable();
      // Longer, softer glide after a flick; slightly quicker wheel zoom.
      map.dragPan.enable({ linearity: 0.24, easing: (t: number) => 1 - (1 - t) ** 3, deceleration: 2300, maxSpeed: 1600 });
      map.scrollZoom.setWheelZoomRate(1 / 380);
      map.scrollZoom.setZoomRate(1 / 90);

      const markers = new FireMarkers(map);
      map.on('load', () => {
        if (disposed || !map) return;
        addIcons(map, () => motionOn() && getState().layers.fires);
        const s0 = getState();
        addOverlays(map, { riskOpacity: s0.riskOpacity, lod: s0.statewideView }, s0.palette);
        cleanups.push(startSync(map, markers));
        cleanups.push(bindInteractions(map, tooltip.current!));
        cleanups.push(() => markers.destroy());
        // Intro: start closer in (still hidden by the loading veil), then pull back to the state.
        // A zoom-out works at every screen size, unlike a fly-in clamped by maxBounds.
        const home = intro ? { center: map.getCenter(), zoom: map.getZoom() } : null;
        if (home) map.jumpTo({ center: [-120.6, 37.9], zoom: home.zoom + 1.35, bearing: -8 });
        setState((s) => ({ map: { ...s.map, ready: true, styleFallback: fallback } }));
        if (home)
          setTimeout(() => {
            if (disposed || !map) return;
            if (getState().selection || getState().highlight) return void map.setBearing(0);
            map.easeTo({ ...home, bearing: 0, duration: MOTION.flyFar + 300, easing: (t: number) => 1 - (1 - t) ** 4, essential: true });
          }, 480);
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
