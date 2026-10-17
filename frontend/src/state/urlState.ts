/**
 * Shareable URL state in the hash:
 *   #map=zoom/lat/lon/bearing/pitch&b=terrain&v=3d&l=fires,risk&t=2026-10-18T22:00Z&sel=place:place-ca-stockton
 * Restored on load (after the needed data arrives) and kept in sync with replaceState.
 */
import type { BasemapStyle, LayerKey, ViewMode } from '../types';
import { HOUR_MS, toIso } from '../lib/time';
import { flyToPoint, getMap } from '../map/mapRef';
import { choosePlace } from './actions';
import { getState, select, setState, setTimeIndex, timelineOf, useStore, validTimeOf } from './store';

const LAYERS: LayerKey[] = ['fires', 'risk', 'wind', 'weather', 'vegetation', 'perimeters'];
const params = () => new URLSearchParams(window.location.hash.replace(/^#/, ''));

type Camera = { center: [number, number]; zoom: number; bearing: number; pitch: number };
function parseCamera(raw: string | null): Camera | null {
  const m = raw?.split('/').map(Number);
  if (!m || m.length < 3 || m.some((v) => !Number.isFinite(v))) return null;
  const [zoom, lat, lon, bearing = 0, pitch = 0] = m;
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  return { center: [lon, lat], zoom, bearing, pitch };
}
// Captured at startup: hash sync may rewrite the URL before the map exists.
const initialMapParam = typeof window === 'undefined' ? null : params().get('map');
const initialCamera = parseCamera(initialMapParam);
export const readInitialCamera = () => initialCamera;

/** Apply view preferences from the URL synchronously (before the map is created). */
export function applyHashPrefs() {
  const p = params();
  const patch: Record<string, unknown> = {};
  const b = p.get('b');
  if (b === 'default' || b === 'terrain') patch.basemap = b as BasemapStyle;
  const v = p.get('v');
  if (v === '2d' || v === '3d') patch.view = v as ViewMode;
  const l = p.get('l');
  if (l != null) {
    const on = new Set(l.split(','));
    patch.layers = Object.fromEntries(LAYERS.map((k) => [k, on.has(k)]));
  }
  setState(patch);
}

/** Restore time + selection once the datasets they refer to are loaded. */
export function restoreHashSelection() {
  const p = params();
  const t = p.get('t') ? Date.parse(p.get('t')!) : NaN;
  const sel = p.get('sel');
  let timeDone = !Number.isFinite(t);
  let selDone = !sel;
  const tryRestore = () => {
    const s = getState();
    if (!timeDone && s.risk.data) {
      timeDone = true;
      const tl = timelineOf(s);
      const idx = Math.round((t - tl.start) / HOUR_MS);
      if (idx > tl.liveIndex && idx < tl.frames) setTimeIndex(idx);
    }
    if (!selDone && sel) {
      const [kind, id] = [sel.slice(0, sel.indexOf(':')), sel.slice(sel.indexOf(':') + 1)];
      if (kind === 'place' && s.places.data) {
        selDone = true;
        const place = s.places.data.find((x) => x.id === id);
        if (place) void choosePlace(place, { fly: !readInitialCamera() });
      } else if (kind === 'cell' && s.risk.data) {
        selDone = true;
        const cell = s.risk.data.cells.find((c) => c.properties.cell_id === id);
        if (cell) {
          const p: [number, number] = [Number(cell.properties.lon), Number(cell.properties.lat)];
          select({ kind: 'cell', cellId: id, lngLat: p });
          if (!initialCamera) flyToPoint(p, 10);
        }
      } else if (kind === 'hotspot' && s.fires.data) {
        selDone = true;
        const d = s.fires.data.detections.find((x) => x.id === id);
        if (d) {
          select({ kind: 'hotspot', detectionId: id });
          if (!initialCamera) flyToPoint([d.lon, d.lat], 12);
        }
      } else if (kind === 'incident' && s.incidents.data) {
        selDone = true;
        const inc = s.incidents.data.incidents.find((i) => i.id === id);
        if (inc) {
          select({ kind: 'incident', incidentId: id });
          if (!initialCamera) flyToPoint(inc.center, 11);
        }
      } else if (!['place', 'cell', 'hotspot', 'incident'].includes(kind)) selDone = true;
    }
    if (timeDone && selDone) unsub();
  };
  const unsub = useStore.subscribe((s) => [s.risk.data, s.places.data, s.fires.data, s.incidents.data], tryRestore);
  tryRestore();
}

function serialize(): string {
  const s = getState();
  const p = new URLSearchParams();
  const map = getMap();
  if (map && getState().map.ready) {
    const c = map.getCenter();
    p.set('map', [map.getZoom().toFixed(2), c.lat.toFixed(4), c.lng.toFixed(4), Math.round(map.getBearing()), Math.round(map.getPitch())].join('/'));
  } else if (initialMapParam) p.set('map', initialMapParam);
  if (s.basemap !== 'default') p.set('b', s.basemap);
  if (s.view !== '2d') p.set('v', s.view);
  p.set('l', LAYERS.filter((k) => s.layers[k]).join(','));
  if (!s.isLive) p.set('t', toIso(validTimeOf(s)).slice(0, 16) + 'Z');
  const sel = s.selection;
  if (sel?.kind === 'place') p.set('sel', `place:${sel.place.id}`);
  else if (sel?.kind === 'cell') p.set('sel', `cell:${sel.cellId}`);
  else if (sel?.kind === 'hotspot') p.set('sel', `hotspot:${sel.detectionId}`);
  else if (sel?.kind === 'incident') p.set('sel', `incident:${sel.incidentId}`);
  else if (s.highlight) p.set('sel', `place:${s.highlight.place.id}`);
  return p.toString().replace(/%2F/g, '/').replace(/%2C/g, ',').replace(/%3A/g, ':');
}

let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    const hash = `#${serialize()}`;
    if (hash !== window.location.hash) history.replaceState(null, '', hash);
  }, 400);
}

export function startHashSync() {
  useStore.subscribe(
    (s) => [s.basemap, s.view, s.layers, s.isLive, s.timeIndex, s.selection, s.highlight, s.map.zoom, s.map.center, s.map.bearing],
    schedule,
    { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
  );
}
