/**
 * Loads every dataset, keeps it fresh, and decides where it comes from:
 *   backend configured → backend; if that fails and nothing was loaded yet → sample data ("fallback").
 *   no backend → sample data.
 * A failed refresh keeps the last good data (shown as stale) instead of swapping to samples.
 */
import { API_BASE, POLL_FIRES_MS, POLL_STATUS_MS } from '../config';
import type { DataProvider } from '../api/provider';
import { RemoteProvider } from '../api/remote';
import { loadPlaceIndex } from '../api/static';
import { coverageFromGroups, groupDetections } from '../lib/fireGroups';
import { HOUR_MS } from '../lib/time';
import { SampleProvider } from '../mock/sampleProvider';
import type { Explanation } from '../types';
import { getState, setState, toast, useStore, type AppState, type Dataset } from './store';

export const remote: DataProvider | null = API_BASE ? new RemoteProvider(API_BASE) : null;
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
        setState({ [key]: { ...prev, error: remoteError } } as Partial<AppState>);
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
export const riskProvider = (): DataProvider => (getState().risk.origin === 'api' && remote ? remote : sample());

export const loadStatus = () => load('status', (p) => p.getStatus());
export const loadFires = () => load('fires', (p) => p.getFires(48));
export const loadIncidents = () => load('incidents', (p) => p.getIncidents());
export const loadCoverage = () => load('coverageApi', (p) => p.getCoverage(48));
export const loadRisk = () => load('risk', (p) => p.getRisk());
export const loadWeather = () => load('weather', (p) => p.getWeather());

export async function loadPlaces() {
  setState({ places: { state: 'loading', data: null, origin: null, error: null, at: null } });
  try {
    const data = await loadPlaceIndex();
    setState({ places: { state: 'ready', data, origin: 'sample', error: null, at: Date.now() } });
  } catch (e) {
    setState({ places: { state: 'error', data: null, origin: null, error: errMsg(e), at: null } });
  }
}

/** Recompute lookback-filtered detections, fire groups and illustrative coverage. */
function derive() {
  const s = getState();
  const all = s.fires.data?.detections ?? [];
  const cutoff = s.now - s.lookbackHours * HOUR_MS;
  const detections = all.filter((d) => Date.parse(d.acquired_at) >= cutoff);
  const incidents = s.incidents.data?.incidents ?? [];
  const groups = groupDetections(detections, incidents);
  const coverage = s.coverageApi.data ?? coverageFromGroups(groups, detections);
  setState({ derived: { detections, groups, coverage } });
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

  void Promise.all([loadStatus(), loadPlaces(), loadFires(), loadIncidents(), loadCoverage(), loadRisk(), loadWeather()]).then(() => {
    const s = getState();
    const fellBack = (['fires', 'risk', 'weather'] as const).filter((k) => s[k].origin === 'fallback');
    if (fellBack.length) toast(`FireWatch API unavailable for ${fellBack.join(', ')} — showing sample data.`, 'error', 8000);
  });

  // Clock: drives the live hour, relative times and lookback filtering.
  setInterval(() => setState({ now: Date.now() }), 30_000);
  setInterval(() => document.visibilityState === 'visible' && loadFires(), POLL_FIRES_MS);
  if (remote) setInterval(() => document.visibilityState === 'visible' && checkStatus(), POLL_STATUS_MS);

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
  if (after.risk_at !== before?.risk_at) {
    explainCache.clear();
    void loadRisk();
  }
  if (after.weather_at !== before?.weather_at) void loadWeather();
}

export async function refreshAll() {
  explainCache.clear();
  await Promise.all([loadStatus(), loadFires(), loadIncidents(), loadCoverage(), loadRisk(), loadWeather()]);
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
