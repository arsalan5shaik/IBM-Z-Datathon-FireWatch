import type { Map as MapLibreMap } from 'maplibre-gl';
import { CA_BOUNDS } from '../config';
import type { BBox, LngLat } from '../lib/geo';
import { getState } from '../state/store';

type Padding = { top: number; bottom: number; left: number; right: number };

let current: MapLibreMap | null = null;
export const setMap = (m: MapLibreMap | null) => (current = m);
export const getMap = () => current;

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
export const isMobile = () => window.innerWidth < 700;

/** Keep the target clear of the floating UI (top bar, controls, timeline, open panels). */
export function overlayPadding(): Padding {
  const s = getState();
  const panelOpen = !!s.selection || s.chatOpen;
  if (isMobile()) {
    return { top: 80, left: 24, right: 24, bottom: panelOpen ? Math.round(window.innerHeight * 0.5) : 150 };
  }
  return { top: 92, left: 84, right: panelOpen ? 420 : 40, bottom: 150 };
}

export function fitBbox(b: BBox, maxZoom = 12.5) {
  const map = current;
  if (!map) return;
  const pad = overlayPadding();
  const w = map.getContainer().clientWidth, h = map.getContainer().clientHeight;
  // Shrink padding on tiny screens so fitBounds never fails.
  const scale = Math.min(1, (w - 60) / (pad.left + pad.right + 1), (h - 60) / (pad.top + pad.bottom + 1));
  const padding = { top: pad.top * scale, bottom: pad.bottom * scale, left: pad.left * scale, right: pad.right * scale };
  map.fitBounds(
    [
      [b[0], b[1]],
      [b[2], b[3]],
    ],
    { padding, maxZoom, duration: reduceMotion() ? 0 : 1100, essential: true },
  );
}

export function flyToPoint(p: LngLat, zoom?: number) {
  const map = current;
  if (!map) return;
  map.easeTo({
    center: p,
    zoom: zoom ?? Math.max(map.getZoom(), 10),
    padding: overlayPadding(),
    duration: reduceMotion() ? 0 : 1000,
    essential: true,
  });
}

export const fitCalifornia = () => fitBbox([CA_BOUNDS[0][0], CA_BOUNDS[0][1], CA_BOUNDS[1][0], CA_BOUNDS[1][1]], 7);
export const zoomBy = (d: number) => current?.easeTo({ zoom: current.getZoom() + d, duration: reduceMotion() ? 0 : 300 });
export const resetNorth = () => current?.easeTo({ bearing: 0, duration: reduceMotion() ? 0 : 500 });
