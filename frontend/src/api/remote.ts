/**
 * FireWatch backend client — routes from FireWatch_Backend_Architecture.md §7 (prefix /api/v1).
 * Implemented in backend/ today: /status, /forecasts/risk, /forecasts/cell/{id}.
 * Planned routes (/fires/live, /fires/incidents, /wind, /explain, /chat) are parsed leniently;
 * a 404 from a route that doesn't exist yet makes that dataset fall back to labelled sample data.
 * See frontend/API_INTEGRATION.md.
 */
import type { FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import { HOUR_MS, floorHour, toIso } from '../lib/time';
import { centroidOfGeometry } from '../lib/geo';
import { riskLevelKey } from '../lib/risk';
import type {
  ChatRequest,
  ChatResponse,
  CoverageCollection,
  Detection,
  Driver,
  Explanation,
  FiresSnapshot,
  Incident,
  IncidentsSnapshot,
  RiskGrid,
  StatusResponse,
  WeatherGrid,
} from '../types';
import type { DataProvider } from './provider';
import { ForecastTiles } from './forecastTiles';
import { HttpError, fetchJson } from './http';

type Area = Polygon | MultiPolygon;
type Props = Record<string, unknown>;

/** California bbox accepted by the backend (≤ 110 square degrees). */
const CA_BBOX = '-124.6,32.4,-114.0,42.1';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const pick = (p: Props, ...keys: string[]) => {
  for (const k of keys) if (p[k] != null) return p[k];
  return undefined;
};

export class RemoteProvider implements DataProvider {
  readonly kind = 'api' as const;
  tiles: ForecastTiles | null = null;
  /** Receives every updated sparse risk grid (wired to the store by state/data.ts). */
  onRiskChange: (grid: RiskGrid) => void = () => undefined;

  constructor(readonly base: string) {}

  private url(path: string, params?: Record<string, string | number>) {
    const q = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : '';
    return `${this.base}${path}${q}`;
  }

  // ---- implemented ------------------------------------------------------------------------
  async getStatus(): Promise<StatusResponse> {
    const s = await fetchJson<Props>(this.url('/status'), { timeoutMs: 10_000 });
    const forecast = (s.forecast as Props | undefined) ?? null;
    const providers = (s.providers as StatusResponse['providers']) ?? null;
    const at = (p?: { last_success_at?: string | null; source_observed_at?: string | null }) => p?.source_observed_at ?? p?.last_success_at ?? null;
    return {
      status: String(s.status ?? 'unknown'),
      runtime_arch: str(s.runtime_arch) ?? undefined,
      model_version: str(forecast?.model_version) ?? str(s.model_version) ?? undefined,
      snapshots: {
        fires_at: at(providers?.firms) ?? str((s.snapshots as Props | undefined)?.fires_at),
        risk_at: str(forecast?.last_success_at) ?? str((s.snapshots as Props | undefined)?.risk_at),
        weather_at: at(providers?.weather),
      },
      data_mode: String(s.data_mode ?? 'unavailable'),
      api_contract_version: 1,
      forecast,
      providers,
    };
  }

  /**
   * Returns the (initially empty) sparse grid after one probe request proves forecasts are
   * served. Further tiles load as the map asks for them (requestView / requestHistory).
   */
  async getRisk(): Promise<RiskGrid> {
    let start = Math.ceil(Date.now() / HOUR_MS) * HOUR_MS; // backend window starts at the next UTC hour
    try {
      const status = await this.getStatus();
      const ws = str(status.forecast?.active_window_start);
      if (ws) start = Date.parse(ws);
    } catch {
      /* status is advisory here */
    }
    this.tiles ??= new ForecastTiles(this.base, start, (g) => this.onRiskChange(g));
    await this.tiles.probe([-119.6, 37.3]);
    return this.tiles.snapshot();
  }

  // ---- planned (lenient parsing) ------------------------------------------------------------
  async getFires(lookbackHours: number): Promise<FiresSnapshot> {
    const since = toIso(Date.now() - lookbackHours * HOUR_MS);
    const res = await fetchJson<FeatureCollection<Point> & { metadata?: Props }>(this.url('/fires/live', { bbox: CA_BBOX, since }));
    const cutoff = Date.parse(since);
    const detections: Detection[] = (res.features ?? [])
      .filter((f) => f.geometry?.type === 'Point')
      .map((f, i) => {
        const p = (f.properties ?? {}) as Props;
        const acquired = str(pick(p, 'acquired_at', 'acquisition_time', 'acq_datetime', 'observed_at', 'timestamp')) ?? '';
        return {
          id: String(f.id ?? pick(p, 'id', 'detection_id') ?? `det-${i}`),
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          acquired_at: acquired,
          sensor: String(pick(p, 'sensor', 'satellite', 'source') ?? 'VIIRS'),
          frp_mw: num(pick(p, 'frp_mw', 'frp')),
          confidence: String(pick(p, 'confidence') ?? 'nominal'),
          display_weight: num(p.display_weight) ?? 0.5,
          daynight: (str(p.daynight) as 'D' | 'N' | null) ?? null,
          incident_id: str(p.incident_id),
        };
      })
      .filter((d) => !d.acquired_at || Date.parse(d.acquired_at) >= cutoff);
    const md = res.metadata ?? {};
    return {
      metadata: {
        source: str(md.source) ?? 'NASA FIRMS',
        generated_at: str(pick(md, 'generated_at', 'fetched_at', 'last_success_at')) ?? toIso(Date.now()),
        stale: md.stale === true,
        not_fire_perimeter: true,
        lookback_hours: lookbackHours,
      },
      detections,
    };
  }

  async getIncidents(): Promise<IncidentsSnapshot> {
    try {
      const res = await fetchJson<FeatureCollection<Area | null> & { metadata?: Props }>(this.url('/fires/incidents', { bbox: CA_BBOX }));
      const incidents: Incident[] = (res.features ?? []).map((f, i) => {
        const p = (f.properties ?? {}) as Props;
        const geometry = f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') ? f.geometry : null;
        const center = (p.center as [number, number] | undefined) ?? (geometry ? centroidOfGeometry(geometry) : [0, 0]);
        return {
          id: String(f.id ?? pick(p, 'incident_id', 'id') ?? `incident-${i}`),
          name: String(pick(p, 'name', 'incident_name') ?? 'Unnamed incident'),
          official: p.official !== false,
          source: String(pick(p, 'source') ?? str(res.metadata?.source) ?? 'Official incident feed'),
          updated_at: str(pick(p, 'updated_at', 'last_updated', 'modified_at')),
          acres: num(pick(p, 'acres', 'acreage', 'gis_acres')),
          containment_pct: num(pick(p, 'containment_pct', 'containment', 'percent_contained')),
          status: str(p.status),
          url: str(p.url),
          geometry,
          center,
        };
      });
      return {
        metadata: { source: str(res.metadata?.source) ?? 'Official incident feed', generated_at: str(res.metadata?.generated_at) ?? toIso(Date.now()), official_perimeter: true },
        incidents,
      };
    } catch (err) {
      // Official perimeters are optional: "not available" is a valid, empty answer.
      if (err instanceof HttpError && err.status === 404)
        return { metadata: { source: 'No official perimeter feed configured', generated_at: toIso(Date.now()), official_perimeter: true }, incidents: [] };
      throw err;
    }
  }

  async getCoverage(): Promise<CoverageCollection | null> {
    return null; // the backend doesn't serve illustrative coverage; the client derives it
  }

  /** One-hour wind/weather snapshot from GET /wind?bbox&hour (GeoJSON points). */
  async getWeather(validAtMs = Date.now()): Promise<WeatherGrid> {
    const hour = floorHour(validAtMs);
    const res = await fetchJson<FeatureCollection<Point> & { metadata?: Props }>(this.url('/wind', { bbox: CA_BBOX, hour: toIso(hour), density: 'medium' }), {
      timeoutMs: 30_000,
    });
    if (Date.parse(String(res.metadata?.forecast_hour)) !== hour) throw new Error('Weather response hour does not match the selected hour');
    const feats = (res.features ?? []).filter((f) => f.geometry?.type === 'Point');
    if (!feats.length) throw new Error('No weather forecast samples for this hour');
    const n = feats.length;
    const col = (...keys: string[]) => Float32Array.from(feats, (f) => num(pick((f.properties ?? {}) as Props, ...keys)) ?? NaN);
    const speedMs = col('wind_speed_ms', 'speed_ms');
    const speedKmh = col('wind_speed_kmh', 'speed_kmh', 'wind_speed', 'speed');
    for (let i = 0; i < n; i++) if (!Number.isFinite(speedKmh[i]) && Number.isFinite(speedMs[i])) speedKmh[i] = speedMs[i] * 3.6;
    return {
      metadata: {
        generated_at: str(pick(res.metadata ?? {}, 'fetched_at', 'generated_at')) ?? '',
        fetched_at: str(res.metadata?.fetched_at) ?? undefined,
        cache_status: res.metadata?.cache_status === 'stale' ? 'stale' : 'fresh',
        complete: res.metadata?.complete !== false,
        data_kind: 'forecast',
        source: str(res.metadata?.source) ?? 'FireWatch API (weather provider)',
        forecast_start: toIso(hour),
        step_minutes: 60,
        frames: 1,
      },
      points: feats.map((f) => f.geometry.coordinates as [number, number]),
      temperature_c: col('temperature_c', 'temperature_2m', 'temperature'),
      relative_humidity_pct: col('relative_humidity_pct', 'relative_humidity_2m', 'humidity'),
      wind_speed_kmh: speedKmh,
      wind_direction_deg: col('wind_direction_deg', 'direction_deg', 'wind_direction', 'direction'),
      wind_gust_kmh: col('wind_gust_kmh', 'gust_kmh', 'wind_gusts'),
      precipitation_mm: col('precipitation_mm', 'precipitation'),
    };
  }

  async explain(cellId: string, validAtMs: number): Promise<Explanation> {
    const raw = await fetchJson<Props>(this.url(`/explain/${encodeURIComponent(cellId)}`, { hour: toIso(floorHour(validAtMs)) }));
    const list = (pick(raw, 'drivers', 'contributions', 'features', 'shap') as Props[] | undefined) ?? [];
    const drivers: Driver[] = list.map((d) => {
      const c = num(pick(d, 'contribution_raw', 'contribution', 'shap_value', 'value_contribution')) ?? 0;
      const v = pick(d, 'value', 'feature_value', 'input_value');
      return {
        feature: String(pick(d, 'feature', 'name') ?? 'feature'),
        label: String(pick(d, 'label', 'display_name', 'name', 'feature') ?? 'Feature'),
        value: typeof v === 'number' || typeof v === 'string' ? v : null,
        unit: str(d.unit) ?? undefined,
        contribution_raw: c,
        direction: c >= 0 ? 'increase' : 'decrease',
      };
    });
    const base = num(pick(raw, 'base_value', 'expected_value')) ?? 0;
    const rawScore = num(pick(raw, 'raw_score', 'margin')) ?? base + drivers.reduce((s, d) => s + d.contribution_raw, 0);
    const score = num(raw.risk_score) ?? 1 / (1 + Math.exp(-rawScore));
    return {
      cell_id: cellId,
      valid_at: str(pick(raw, 'forecast_hour', 'valid_at')) ?? toIso(validAtMs),
      model_version: str(raw.model_version) ?? 'unknown',
      risk_score: score,
      risk_level: riskLevelKey(score),
      score_type: str(raw.score_type) ?? 'relative_risk',
      base_value: base,
      raw_score: rawScore,
      output_scale: str(raw.output_scale) ?? 'log_odds',
      drivers,
      conditions: ((pick(raw, 'conditions', 'inputs') as Explanation['conditions']) ?? {}) as Explanation['conditions'],
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Architecture §7: {message, context?: {cell_id, place_id, hour, incident_id}}
    const context = Object.fromEntries(
      Object.entries({ cell_id: req.cell_id, place_id: req.location_id, hour: req.valid_at, incident_id: req.incident_id }).filter(([, v]) => v),
    );
    const res = await fetchJson<Props>(this.url('/chat'), {
      method: 'POST',
      body: { message: req.message, ...(Object.keys(context).length ? { context } : {}) },
      timeoutMs: 30_000,
    });
    const cites = (pick(res, 'grounding', 'citations', 'sources') as Props[] | undefined) ?? [];
    return {
      answer: String(pick(res, 'answer', 'message', 'text') ?? ''),
      grounding: cites.map((c) => ({ dataset: String(pick(c, 'dataset', 'source', 'name', 'tool') ?? 'source'), as_of: str(pick(c, 'as_of', 'timestamp', 'observed_at', 'valid_at')) })),
      disclaimer: str(res.disclaimer) ?? undefined,
    };
  }

  // ---- on-demand risk -------------------------------------------------------------------------
  requestView(bbox: [number, number, number, number], t: number, maxTiles?: number) {
    return this.tiles?.ensureView(bbox, t, maxTiles) ?? 'ok';
  }
  requestHistory(cellId: string) {
    void this.tiles?.ensureHistory(cellId);
  }
}

