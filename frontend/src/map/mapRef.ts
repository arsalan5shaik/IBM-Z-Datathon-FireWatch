import type { Map as MapLibreMap } from 'maplibre-gl';
import { CA_BOUNDS } from '../config';
import { distanceKm, type BBox, type LngLat } from '../lib/geo';
import { getState } from '../state/store';
import { MOTION, motionOn } from './motion';

type Padding = { top: number; bottom: number; left: number; right: number };

let current: MapLibreMap | null = null;
export const setMap = (m: MapLibreMap | null) => (current = m);
export const getMap = () => current;

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

const dur = (ms: number) => (motionOn() ? ms : 0);

export function fitBbox(b: BBox, maxZoom = 12.5) {
  const map = current;
  if (!map) return;
  const pad = overlayPadding();
  const w = map.getContainer().clientWidth, h = map.getContainer().clientHeight;
  // Shrink padding on tiny screens so fitBounds never fails.
  const scale = Math.min(1, (w - 60) / (pad.left + pad.right + 1), (h - 60) / (pad.top + pad.bottom + 1));
  const padding = { top: pad.top * scale, bottom: pad.bottom * scale, left: pad.left * scale, right: pad.right * scale };
  const c = map.getCenter();
  const far = distanceKm([c.lng, c.lat], [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]) > 120;
  // fitBounds flies (zoom out → in) by default; give long hops a little more time.
  map.fitBounds(
    [
      [b[0], b[1]],
      [b[2], b[3]],
    ],
    { padding, maxZoom, duration: dur(far ? MOTION.flyFar : 1100), essential: true },
  );
}

/**
 * Move to a point: nearby targets glide (easeTo); distant ones fly out and back in (flyTo), which
 * keeps context instead of smearing the map sideways.
 */
export function flyToPoint(p: LngLat, zoom?: number) {
  const map = current;
  if (!map) return;
  const c = map.getCenter();
  const km = distanceKm([c.lng, c.lat], p);
  const targetZoom = zoom ?? Math.max(map.getZoom(), 10);
  const opts = { center: p, zoom: targetZoom, padding: overlayPadding(), essential: true };
  if (km > 80 && motionOn()) map.flyTo({ ...opts, curve: 1.5, speed: 1.4, maxDuration: MOTION.flyFar + 600 });
  else map.easeTo({ ...opts, duration: dur(MOTION.camera) });
}

/**
 * If `p` is hidden behind the details panel (desktop) or bottom sheet (phone), glide just enough to
 * reveal it. Does nothing when it is already visible.
 */
export function ensureVisible(p: LngLat) {
  const map = current;
  if (!map) return;
  const pt = map.project(p);
  const pad = overlayPadding();
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const margin = 24;
  const hidden = pt.x > w - pad.right + margin || pt.x < pad.left - margin || pt.y > h - pad.bottom + margin || pt.y < pad.top - margin;
  if (!hidden) return;
  map.easeTo({ center: p, padding: pad, duration: dur(MOTION.slow + 180), essential: true });
}

export const fitCalifornia = () => fitBbox([CA_BOUNDS[0][0], CA_BOUNDS[0][1], CA_BOUNDS[1][0], CA_BOUNDS[1][1]], 7);
export const zoomBy = (d: number) => current?.easeTo({ zoom: current.getZoom() + d, duration: dur(300) });
export const resetNorth = () => current?.easeTo({ bearing: 0, pitch: getState().view === '3d' ? current.getPitch() : 0, duration: dur(500) });
