import { create } from 'zustand';
import { API_BASE } from '../config';
import { subscribeWithSelector } from 'zustand/middleware';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { loadJson, saveJson } from '../lib/storage';
import type { PaletteKey } from '../lib/palette';
import { HOUR_MS, floorHour } from '../lib/time';
import type {
  BasemapStyle,
  ChatSource,
  CoverageCollection,
  DataOrigin,
  Detection,
  FireGroup,
  FiresSnapshot,
  Grounding,
  IncidentsSnapshot,
  LayerKey,
  LoadState,
  PlaceResult,
  RiskGrid,
  Selection,
  StatusResponse,
  Units,
  ViewMode,
  WeatherGrid,
} from '../types';

export interface Dataset<T> {
  state: LoadState;
  data: T | null;
  origin: DataOrigin | null;
  error: string | null;
  at: number | null;
}
const empty = <T,>(): Dataset<T> => ({ state: 'idle', data: null, origin: null, error: null, at: null });

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  grounding?: Grounding[];
  mode?: 'api' | 'offline' | 'error';
  at: number;
  sources?: ChatSource[];
  limitations?: string[];
  suggested_questions?: string[];
  context_label?: string;
  context_key?: string;
  retry_text?: string;
  model?: string | null;
}
export interface ChatContext {
  label: string;
  placeId?: string;
  cellId?: string;
  detectionId?: string;
  incidentId?: string;
  groupId?: string;
  lngLat?: [number, number];
}
export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error' | 'success';
}

export type StatewideView = 'surface' | 'coarse' | 'cells';

export interface Prefs {
  basemap: BasemapStyle;
  view: ViewMode;
  layers: Record<LayerKey, boolean>;
  riskOpacity: number;
  lookbackHours: number;
  units: Units;
  legendCollapsed: boolean;
  /** In-app motion switch (the OS reduced-motion setting always wins). */
  smoothMotion: boolean;
  /** How the sample forecast is drawn at statewide zoom. */
  statewideView: StatewideView;
  /** 3D: raise risk cells by score. */
  skyline: boolean;
  /** Day/night shading for the selected hour. */
  dayNight: boolean;
  /** Risk colour ramp (colour-vision-deficiency-safe option). */
  palette: PaletteKey;
  /** Animated streaks travelling downwind (with the wind layer). */
  windFlow: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  basemap: 'default',
  view: '2d',
  layers: { fires: true, risk: true, wind: false, weather: false, vegetation: false, perimeters: true },
  riskOpacity: 0.85,
  lookbackHours: 24,
  units: 'us',
  legendCollapsed: typeof window !== 'undefined' && window.innerWidth < 640,
  smoothMotion: true,
  statewideView: 'surface',
  skyline: false,
  dayNight: false,
  palette: 'default',
  windFlow: true,
};

export interface MapInfo {
  ready: boolean;
  styleFallback: boolean;
  terrainError: boolean;
  webglError: boolean;
  zoom: number;
  bearing: number;
  pitch: number;
  center: [number, number];
}

export interface Replay {
  /** Window being replayed (epoch ms). */
  from: number;
  to: number;
  /** Current replay clock. */
  at: number;
  playing: boolean;
}
export interface TourStop {
  lngLat: [number, number];
  label: string;
  score: number;
  t: number;
  cellId?: string;
}

export type Speed = 1 | 2 | 4 | 8 | 16;

export interface AppState extends Prefs {
  now: number;
  timeIndex: number;
  isLive: boolean;
  playing: boolean;
  speed: Speed;
  replay: Replay | null;
  tour: { stops: TourStop[]; index: number; paused: boolean } | null;

  selection: Selection | null;
  highlight: { place: PlaceResult; boundary: Feature<Polygon | MultiPolygon> | null } | null;
  userLocation: { lngLat: [number, number]; accuracy: number } | null;

  layersOpen: boolean;
  chatOpen: boolean;
  aboutOpen: boolean;
  calendarOpen: boolean;
  shortcutsOpen: boolean;
  toasts: Toast[];
  chat: { messages: ChatMessage[]; pending: boolean; context: ChatContext | null };

  status: Dataset<StatusResponse>;
  fires: Dataset<FiresSnapshot>;
  incidents: Dataset<IncidentsSnapshot>;
  coverageApi: Dataset<CoverageCollection | null>;
  risk: Dataset<RiskGrid>;
  weather: Dataset<WeatherGrid>;
  places: Dataset<PlaceResult[]>;
  derived: { detections: Detection[]; groups: FireGroup[]; coverage: CoverageCollection };

  map: MapInfo;
  online: boolean;
  /** Backend mode only: whether the visible area's forecast tiles are loaded. */
  riskCoverage: 'ok' | 'zoom-in' | 'loading' | 'missing-hour' | 'error' | null;
}

const saved = loadJson<Partial<Prefs>>('prefs', {});
const initialPrefs: Prefs = { ...DEFAULT_PREFS, ...saved, layers: { ...DEFAULT_PREFS.layers, ...(saved.layers ?? {}) } };

export const useStore = create<AppState>()(
  subscribeWithSelector((): AppState => ({
    ...initialPrefs,
    now: Date.now(),
    timeIndex: 0,
    isLive: true,
    playing: false,
    speed: 1,
    replay: null,
    tour: null,

    selection: null,
    highlight: null,
    userLocation: null,

    layersOpen: false,
    chatOpen: false,
    aboutOpen: false,
    calendarOpen: false,
    shortcutsOpen: false,
    toasts: [],
    chat: { messages: [], pending: false, context: null },

    status: empty<StatusResponse>(),
    fires: empty<FiresSnapshot>(),
    incidents: empty<IncidentsSnapshot>(),
    coverageApi: empty<CoverageCollection | null>(),
    risk: empty<RiskGrid>(),
    weather: empty<WeatherGrid>(),
    places: empty<PlaceResult[]>(),
    derived: { detections: [], groups: [], coverage: { type: 'FeatureCollection', features: [] } },

    map: { ready: false, styleFallback: false, terrainError: false, webglError: false, zoom: 5, bearing: 0, pitch: 0, center: [-119.5, 37.2] },
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    riskCoverage: null,
  })),
);

export const getState = useStore.getState;
export const setState = useStore.setState;

// Persist preferences.
useStore.subscribe(
  (s): Prefs => ({
    basemap: s.basemap,
    view: s.view,
    layers: s.layers,
    riskOpacity: s.riskOpacity,
    lookbackHours: s.lookbackHours,
    units: s.units,
    legendCollapsed: s.legendCollapsed,
    smoothMotion: s.smoothMotion,
    statewideView: s.statewideView,
    skyline: s.skyline,
    dayNight: s.dayNight,
    palette: s.palette,
    windFlow: s.windFlow,
  }),
  (prefs) => saveJson('prefs', prefs),
  { equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
);

// ---- timeline -----------------------------------------------------------------
export interface Timeline {
  start: number;
  step: number;
  frames: number;
  liveIndex: number;
  expired: boolean;
}
/** The hourly timeline axis: 7 days from the forecast start (or the current hour before data loads). */
export function timelineOf(s: Pick<AppState, 'risk' | 'now'>): Timeline {
  const md = s.risk.data?.metadata;
  const start = md ? Date.parse(md.forecast_start) : floorHour(s.now);
  const horizonH = md ? Math.max(1, Math.round((md.frames * md.step_minutes) / 60)) : 168;
  const frames = Math.min(168, Math.max(24, horizonH));
  const raw = Math.floor((s.now - start) / HOUR_MS);
  return { start, step: HOUR_MS, frames, liveIndex: Math.max(0, Math.min(frames - 1, raw)), expired: raw > frames - 1 };
}
export function effectiveIndex(s: AppState, tl = timelineOf(s)): number {
  return s.isLive ? tl.liveIndex : Math.max(tl.liveIndex, Math.min(tl.frames - 1, s.timeIndex));
}
export const validTimeOf = (s: AppState) => {
  const tl = timelineOf(s);
  return tl.start + effectiveIndex(s, tl) * tl.step;
};
/** Index into a dataset whose frames start at `start` and advance by `stepMin` minutes. */
export function frameAt(t: number, startIso: string, stepMin: number, frames: number): number {
  const f = Math.floor((t - Date.parse(startIso)) / (stepMin * 60_000) + 1e-6);
  return Math.max(0, Math.min(frames - 1, f));
}

// ---- simple actions ----------------------------------------------------------
let toastId = 0;
export function toast(message: string, kind: Toast['kind'] = 'info', ms = 4500) {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.filter((t) => t.message !== message), { id, message, kind }].slice(-3) }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
export const dismissToast = (id: number) => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));

export function setTimeIndex(i: number, { keepPlaying = false } = {}) {
  const s = getState();
  const tl = timelineOf(s);
  const idx = Math.max(tl.liveIndex, Math.min(tl.frames - 1, Math.round(i)));
  if (API_BASE && (!s.risk.data || (s.risk.data.metadata.available_hours && !s.risk.data.metadata.available_hours.some((hour) => Date.parse(hour) === tl.start + idx * HOUR_MS)))) {
    setState({ playing: false });
    toast('No validated model prediction is published for this hour.');
    return;
  }
  setState({ timeIndex: idx, isLive: idx === tl.liveIndex, playing: keepPlaying ? s.playing : false });
}
export const stepTime = (deltaHours: number) => {
  const s = getState();
  setTimeIndex(effectiveIndex(s) + deltaHours);
};
/** Milliseconds per playback step at a speed (1× = 420 ms per forecast hour). */
export const playbackTickMs = (speed: Speed) => 420 / speed;

export const goLive = () => setState({ isLive: true, playing: false, timeIndex: timelineOf(getState()).liveIndex });
export function togglePlay() {
  const s = getState();
  if (s.playing || (API_BASE && !s.risk.data)) return setState({ playing: false });
  const tl = timelineOf(s);
  const at = effectiveIndex(s, tl);
  setState({ playing: true, isLive: false, timeIndex: at >= tl.frames - 1 ? tl.liveIndex : at });
}

export const toggleLayer = (key: LayerKey) => setState((s) => ({ layers: { ...s.layers, [key]: !s.layers[key] } }));
export const setLayer = (key: LayerKey, on: boolean) => setState((s) => ({ layers: { ...s.layers, [key]: on } }));

export function select(selection: Selection | null) {
  setState({ selection, layersOpen: false, calendarOpen: false });
}
export function clearSelection() {
  setState({ selection: null });
}
export function closeOverlays(): boolean {
  const s = getState();
  if (s.tour) return (setState({ tour: null }), true);
  if (s.replay) return (setState({ replay: null }), true);
  if (s.shortcutsOpen) return (setState({ shortcutsOpen: false }), true);
  if (s.aboutOpen) return (setState({ aboutOpen: false }), true);
  if (s.calendarOpen) return (setState({ calendarOpen: false }), true);
  if (s.layersOpen) return (setState({ layersOpen: false }), true);
  if (s.chatOpen) return (setState({ chatOpen: false }), true);
  if (s.selection) return (setState({ selection: null }), true);
  return false;
}
