import { loadCaBoundary } from '../api/static';
import { locationBoundary } from '../api/locations';
import { API_BASE } from '../config';
import { pointInGeometry, type LngLat } from '../lib/geo';
import { loadJson, saveJson } from '../lib/storage';
import { placeTitle } from '../lib/search';
import { formatHour, formatWeekday } from '../lib/time';
import { fitBbox, flyToPoint } from '../map/mapRef';
import type { PlaceResult, Selection } from '../types';
import { sendChat } from './chat';
import { cellIndexAt, describePoint } from './lookups';
import { getState, select, setState, toast, validTimeOf, type ChatContext } from './store';

const RECENT_KEY = 'recent-places';
export const recentPlaceIds = () => loadJson<string[]>(RECENT_KEY, []);
let boundaryRequest = 0;
let boundaryAbort: AbortController | null = null;

/** Select a search result: highlight its boundary, fit the map to it and open its panel. */
export async function choosePlace(place: PlaceResult, { fly = true } = {}) {
  const request = ++boundaryRequest;
  boundaryAbort?.abort();
  const ctrl = new AbortController();
  boundaryAbort = ctrl;
  setState(s => ({ highlight: { place, boundary: null },
    ...(API_BASE && s.highlight?.place.id !== place.id ? { weather: { ...s.weather, data: null, state: 'loading', error: null } } : {}),
  }));
  select({ kind: 'place', place });
  if (fly) fitBbox(place.bbox, place.type === 'county' ? 10 : place.type === 'zip' ? 13 : 12.5);
  saveJson(RECENT_KEY, [place.id, ...recentPlaceIds().filter((id) => id !== place.id)].slice(0, 5));
  try {
    const boundary = await locationBoundary(place, ctrl.signal);
    if (request !== boundaryRequest) return;
    if (getState().highlight?.place.id === place.id) setState({ highlight: { place, boundary } });
    if (!boundary) toast(`No boundary available for ${placeTitle(place)}.`);
  } catch {
    if (request !== boundaryRequest || ctrl.signal.aborted) return;
    toast(`Couldn’t load the outline for ${placeTitle(place)}.`, 'error');
  }
}

export function clearSearch() {
  ++boundaryRequest;
  boundaryAbort?.abort();
  const s = getState();
  setState({ highlight: null });
  if (s.selection?.kind === 'place') select(null);
}

let caGeom: Awaited<ReturnType<typeof loadCaBoundary>> | null = null;
export async function isInCalifornia(p: LngLat): Promise<boolean> {
  caGeom ??= await loadCaBoundary();
  return caGeom.features.some((f) => pointInGeometry(p, f.geometry));
}

/** Select the forecast cell under a point (or just fly there if no cell covers it). */
export async function goToPoint(p: LngLat, zoom = 11) {
  if (!(await isInCalifornia(p))) {
    toast('That location is outside California. FireWatch covers California only.', 'error');
    return false;
  }
  const grid = getState().risk.data;
  const i = grid ? cellIndexAt(grid, p) : -1;
  if (grid && i >= 0) select({ kind: 'cell', cellId: grid.cells[i].properties.cell_id, lngLat: p });
  flyToPoint(p, zoom);
  return true;
}

export function locateMe(): Promise<void> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      toast('Location isn’t available in this browser.', 'error');
      return resolve();
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const p: LngLat = [pos.coords.longitude, pos.coords.latitude];
        if (await isInCalifornia(p)) {
          setState({ userLocation: { lngLat: p, accuracy: pos.coords.accuracy } });
          await goToPoint(p, 11);
        } else {
          toast('Your location appears to be outside California. FireWatch covers California only.', 'error', 6000);
        }
        resolve();
      },
      (err) => {
        const msg =
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was denied. Allow it in your browser settings to use “Locate me”.'
            : err.code === err.TIMEOUT
              ? 'Finding your location timed out. Please try again.'
              : 'Couldn’t determine your location.';
        toast(msg, 'error', 6000);
        resolve();
      },
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 120_000 },
    );
  });
}

/** Chat context label for the current selection, e.g. "Stockton · Sat 3 PM". */
export function contextFor(sel: Selection | null): ChatContext | null {
  const s = getState();
  const t = validTimeOf(s);
  const when = `${formatWeekday(t)} ${formatHour(t)}`;
  if (!sel) return null;
  switch (sel.kind) {
    case 'place':
      return { label: `${placeTitle(sel.place)} · ${when}`, placeId: sel.place.id, lngLat: sel.place.center };
    case 'cell': {
      const cell = s.risk.data?.cells.find((c) => c.properties.cell_id === sel.cellId);
      const where = describePoint(s.places.data, sel.lngLat, cell?.properties);
      const near = where.near ? `near ${where.near}` : sel.cellId;
      return { label: `Area ${near} · ${when}`, cellId: sel.cellId, lngLat: sel.lngLat };
    }
    case 'hotspot': {
      const d = s.fires.data?.detections.find((x) => x.id === sel.detectionId);
      return { label: 'Selected hotspot', detectionId: sel.detectionId, lngLat: d ? [d.lon, d.lat] : undefined };
    }
    case 'incident': {
      const inc = s.incidents.data?.incidents.find((i) => i.id === sel.incidentId);
      return { label: inc?.name ?? 'Selected incident', incidentId: sel.incidentId, lngLat: inc?.center };
    }
    case 'group': {
      const g = s.derived.groups.find((x) => x.id === sel.groupId);
      return { label: 'Hotspot cluster', groupId: sel.groupId, lngLat: g?.center };
    }
  }
}

/** Open the assistant with the current selection as context, optionally asking a question right away. */
export function askAbout(question?: string) {
  const ctx = contextFor(getState().selection);
  setState((s) => ({ chatOpen: true, layersOpen: false, chat: { ...s.chat, context: ctx ?? s.chat.context } }));
  if (question) void sendChat(question);
}

export const selectCellAtPoint = (p: LngLat) => {
  const grid = getState().risk.data;
  if (!grid) return;
  const i = cellIndexAt(grid, p);
  if (i >= 0) select({ kind: 'cell', cellId: grid.cells[i].properties.cell_id, lngLat: p });
};
