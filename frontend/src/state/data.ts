/**
 * Loads every dataset, keeps it fresh, and decides where it comes from:
 *   backend configured → backend; unavailable observations/forecasts stay explicitly unavailable.
 *   no backend → sample data.
 * A failed refresh keeps the last good data (shown as stale) instead of swapping to samples.
 */
import { API_BASE, POLL_FIRES_MS, POLL_STATUS_MS } from '../config';
import type { DataProvider } from '../api/provider';
import { RemoteProvider } from '../api/remote';
import { loadCounties, loadPlaceIndex } from '../api/static';
import { setCountyShapes } from './lookups';
import { coverageFromGroups, groupDetections } from '../lib/fireGroups';
import { HOUR_MS, floorHour } from '../lib/time';
import { SampleProvider } from '../mock/sampleProvider';
import type { CoverageCollection, Explanation, FireGroup, WeatherGrid } from '../types';
import { compute } from '../lib/compute';
import { getState, setState, toast, useStore, validTimeOf, type AppState, type Dataset } from './store';

export const remote: RemoteProvider | null = API_BASE ? new RemoteProvider(API_BASE) : null;
let sampleInstance: SampleProvider | null = null;
export const sample = (): DataProvider => (sampleInstance ??= new SampleProvider());

type Key = 'status' | 'fires' | 'incidents' | 'coverageApi' | 'risk' | 'weather';
type DataOf<K extends Key> = AppState[K] extends Dataset<infer T> ? T : never;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function load<K extends Key>(key: K, fetcher: (p: DataProvider) => Promise<DataOf<K>>): Promise<void> {
  const prev = getState()[key] as Dataset<DataOf<K>>;
  setState({ [key]: { ...prev, state: prev.data ? prev.state : 'loading' } } as Partial<AppState>);
  let remoteError: string | null = null;
  if (remote) {
    try {
      const data = await fetcher(remote);
      setState({ [key]: { state: 'ready', data, origin: 'api', error: null, at: Date.now() } } as Partial<AppState>);
      return;
    } catch (e) {
      remoteError = errMsg(e);
      if (prev.data && prev.origin === 'api') {
        const data = key === 'fires' ? { ...getState().fires.data!, metadata: { ...getState().fires.data!.metadata, stale: true, cache_status: 'stale' as const } } : prev.data;
        setState({ [key]: { ...prev, data, error: remoteError } } as Partial<AppState>);
        return;
      }
      if (key === 'fires' || key === 'risk' || key === 'status' || key === 'incidents') {
        // A real-data outage must not turn into synthetic observations or predictions.
        setState({ [key]: { state: 'error', data: null, origin: 'api', error: remoteError, at: Date.now() }, ...(key === 'risk' ? { isLive: true, playing: false } : {}) } as Partial<AppState>);
        return;
      }
    }
  }
  try {
    const data = await fetcher(sample());
    setState({
      [key]: { state: 'ready', data, origin: remote ? 'fallback' : 'sample', error: remoteError, at: Date.now() },
    } as Partial<AppState>);
  } catch (e) {
    setState({ [key]: { ...prev, state: 'error', error: remoteError ?? errMsg(e) } } as Partial<AppState>);
  }
}

/** Provider that served the risk grid — explanations must come from the same model. */
export const riskProvider = (): DataProvider => (remote ?? sample());
const apiRisk = () => !!remote && getState().risk.origin === 'api' && getState().risk.state === 'ready' && !!getState().risk.data;

export const loadStatus = () => load('status', (p) => p.getStatus());
export const loadFires = () => load('fires', (p) => p.getFires(48));
export const loadCoverage = () => load('coverageApi', (p) => p.getCoverage(48));
export const loadRisk = () => load('risk', (p) => p.getRisk());

/** Sample incidents only make sense next to sample detections; live detections never get fictional names. */
export async function loadIncidents() {
  if (!remote && getState().fires.origin !== 'api') {
    const data = await sample().getIncidents();
    setState({ incidents: { state: 'ready', data, origin: 'fallback', error: null, at: Date.now() } });
    return;
  }
  return load('incidents', (p) => p.getIncidents());
}

// The backend serves weather one hour at a time; keep a small per-hour cache.
const weatherCache = new Map<string, { grid: WeatherGrid; loadedAt: number }>();
let weatherRequest = 0;
let weatherAbort: AbortController | null = null;
export async function loadWeather(force = false) {
  const hour = floorHour(validTimeOf(getState()));
  const place = getState().highlight?.place;
  const key = `${hour}|${place?.id ?? ''}`;
  if (!remote) return load('weather', (p) => p.getWeather(hour));
  const request = ++weatherRequest;
  weatherAbort?.abort();
  const ctrl = new AbortController();
  weatherAbort = ctrl;
  if (!force) {
    const cached = weatherCache.get(key);
    if (cached && Date.now() - cached.loadedAt < 60_000)
      return setState({ weather: { state: 'ready', data: cached.grid, origin: 'api', error: null, at: cached.loadedAt } });
  }
  const previous = { ...getState().weather };
  if (previous.data?.metadata.location_id !== place?.id) previous.data = null;
  setState({ weather: { ...previous, state: 'loading', error: null } });
  try {
    const data = place ? await remote.getLocationWeather(place, hour, ctrl.signal) : await remote.getWeather(hour);
    if (request !== weatherRequest || floorHour(validTimeOf(getState())) !== hour || getState().highlight?.place.id !== place?.id) return;
    const at = Date.now();
    const stale = data.metadata.cache_status === 'stale';
    setState({ weather: { state: 'ready', data, origin: 'api', error: stale ? 'Showing stale forecast weather' : null, at } });
    if (!stale) weatherCache.set(key, { grid: data, loadedAt: at });
    if (weatherCache.size > 24) weatherCache.delete(weatherCache.keys().next().value!);
  } catch (error) {
    if (request !== weatherRequest || floorHour(validTimeOf(getState())) !== hour || getState().highlight?.place.id !== place?.id) return;
    // Keep labeled last-good data; lookups reject it outside its exact valid hour.
    setState({ weather: { ...previous, data: place ? null : previous.origin === 'api' ? previous.data : null, state: 'error', origin: 'api', error: errMsg(error) } });
  }
}

export async function loadPlaces() {
  setState({ places: { state: 'loading', data: null, origin: null, error: null, at: null } });
  try {
    const [data, counties] = await Promise.all([loadPlaceIndex(), loadCounties().catch(() => null)]);
    if (counties) setCountyShapes(counties);
    setState({ places: { state: 'ready', data, origin: 'sample', error: null, at: Date.now() } });
  } catch (e) {
    setState({ places: { state: 'error', data: null, origin: null, error: errMsg(e), at: null } });
  }
}

// ---- backend risk: on-demand tiles ---------------------------------------------------------
type BBoxT = [number, number, number, number];
/** Ask for the forecast cells covering the visible map at the selected hour (backend mode). */
let lastView: BBoxT | null = null;
export function requestRiskView(bbox: BBoxT, t: number) {
  if (!apiRisk()) return;
  lastView = bbox;
  const coverage = remote!.requestView(bbox, t);
  if (getState().riskCoverage !== coverage) setState({ riskCoverage: coverage });
  // A 25 % margin around the view loads in the background, so short pans reveal ready cells.
  const [w, s, e, n] = bbox;
  const mx = (e - w) * 0.25, my = (n - s) * 0.25;
  if (coverage !== 'zoom-in') remote!.requestView([w - mx, s - my, e + mx, n + my], t, 20);
  // Upcoming hours load quietly so stepping and playback don't wait on the network.
  if (coverage === 'ok' || coverage === 'loading') remote!.prefetchHours(t, getState().playing ? 6 : 2);
}
/** Re-evaluate the visible area's coverage when tiles arrive (no new requests for loaded tiles). */
function refreshCoverage() {
  if (!lastView || !apiRisk()) return;
  const coverage = remote!.requestView(lastView, validTimeOf(getState()));
  if (getState().riskCoverage !== coverage) setState({ riskCoverage: coverage });
}
/** Per-hour load state of the visible forecast tiles (backend mode; null in sample mode). */
export const riskHourStates = () => (apiRisk() ? remote!.hourStates() : null);
/** A searched place may extend beyond the screen; allow more tiles for it. */
export function requestRiskArea(bbox: BBoxT, t: number) {
  if (apiRisk()) remote!.requestView(bbox, t, 40);
}
export function requestCellHistory(cellId: string) {
  if (apiRisk()) remote!.requestHistory(cellId);
}

/**
 * Recompute lookback-filtered detections, fire groups and illustrative coverage. Clustering and the
 * influence contours run in the compute worker so a large hotspot refresh never stalls the map.
 */
let deriveSeq = 0;
function derive() {
  const s = getState();
  const all = s.fires.data?.detections ?? [];
  const cutoff = s.now - s.lookbackHours * HOUR_MS;
  const detections = all.filter((d) => Date.parse(d.acquired_at) >= cutoff);
  const incidents = s.incidents.data?.incidents ?? [];
  const seq = ++deriveSeq;
  const apiCoverage = s.coverageApi.data;
  void compute<{ groups: FireGroup[]; coverage: CoverageCollection }>({ op: 'fires', detections, incidents })
    .catch(() => {
      const groups = groupDetections(detections, incidents);
      return { groups, coverage: coverageFromGroups(groups, detections) };
    })
    .then(({ groups, coverage }) => {
      if (seq === deriveSeq) setState({ derived: { detections, groups, coverage: apiCoverage ?? coverage } });
    });
}

let started = false;
export function startData() {
  if (started) return;
  started = true;
  useStore.subscribe(
    (s) => [s.fires.data, s.incidents.data, s.coverageApi.data, s.lookbackHours, Math.floor(s.now / 600_000)] as const,
    derive,
    { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
  );

  if (remote) {
    // Sparse backend grid updates as tiles arrive.
    remote.onRiskChange = (grid) => {
      if (getState().risk.origin === 'api' && getState().risk.state === 'ready') {
        setState((s) => ({ risk: { ...s.risk, data: grid, at: Date.now() } }));
        refreshCoverage();
      }
    };
    // Backend weather is per hour: follow the timeline (debounced so playback doesn't flood the API).
    let timer = 0;
    useStore.subscribe(
      (s) => `${floorHour(validTimeOf(s))}|${s.highlight?.place.id ?? ''}`,
      () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => void loadWeather(), getState().playing ? 600 : 150);
      },
    );
  }

  void Promise.all([
    loadStatus(),
    loadPlaces(),
    loadFires().then(loadIncidents),
    loadCoverage(),
    loadRisk(),
    loadWeather(),
  ]).then(() => {
    const s = getState();
    const fellBack = (['fires', 'risk', 'weather'] as const).filter((k) => s[k].origin === 'fallback');
    if (fellBack.length) toast(`FireWatch API data unavailable for ${fellBack.join(', ')} — showing sample data for those.`, 'error', 8000);
  });

  // Clock: drives the live hour, relative times and lookback filtering.
  setInterval(() => setState({ now: Date.now() }), 30_000);
  setInterval(() => document.visibilityState === 'visible' && loadFires(), POLL_FIRES_MS);
  if (remote) setInterval(() => document.visibilityState === 'visible' && checkStatus(), POLL_STATUS_MS);
  if (remote) setInterval(() => document.visibilityState === 'visible' && loadWeather(), 60_000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    setState({ now: Date.now() });
    const at = getState().fires.at;
    if (!at || Date.now() - at > POLL_FIRES_MS) void loadFires();
  });
  window.addEventListener('online', () => {
    setState({ online: true });
    toast('Back online — refreshing data.', 'success');
    void refreshAll();
  });
  window.addEventListener('offline', () => {
    setState({ online: false });
    toast('You’re offline. Showing the last loaded data.', 'error', 6000);
  });
}

/** Reload datasets whose snapshot timestamps changed on the server. */
async function checkStatus() {
  const before = getState().status.data?.snapshots;
  await loadStatus();
  const after = getState().status.data?.snapshots;
  if (!after) return;
  if (after.fires_at !== before?.fires_at) void loadFires();
  if (after.risk_at !== before?.risk_at && after.risk_at) {
    explainCache.clear();
    void loadRisk();
  }
  if (after.weather_at !== before?.weather_at && after.weather_at) {
    weatherCache.clear();
    void loadWeather(true);
  }
}

export async function refreshAll() {
  explainCache.clear();
  weatherCache.clear();
  remote?.tiles?.reset(Date.parse(getState().risk.data?.metadata.forecast_start ?? '') || Math.ceil(Date.now() / HOUR_MS) * HOUR_MS);
  await Promise.all([loadStatus(), loadFires().then(loadIncidents), loadCoverage(), loadRisk(), loadWeather(true)]);
}

// ---- explanations ----------------------------------------------------------------
const explainCache = new Map<string, Promise<Explanation>>();
export function getExplanation(cellId: string, validAt: number): Promise<Explanation> {
  const origin = getState().risk.origin ?? 'sample';
  const key = `${origin}|${cellId}|${validAt}`;
  let p = explainCache.get(key);
  if (!p) {
    p = riskProvider().explain(cellId, validAt);
    p.catch(() => explainCache.delete(key));
    explainCache.set(key, p);
    if (explainCache.size > 400) explainCache.delete(explainCache.keys().next().value!);
  }
  return p;
}
