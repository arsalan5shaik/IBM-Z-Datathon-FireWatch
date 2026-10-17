/**
 * FireWatch backend provider (/api/v1). See frontend/API_INTEGRATION.md for the exact shapes.
 * Frozen endpoints from 02_API_CONTRACT.md are used as-is; the hourly endpoints are additive.
 */
import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from 'geojson';
import { HOUR_MS, floorHour, toIso } from '../lib/time';
import { bboxOfGeometry, centroidOfGeometry } from '../lib/geo';
import { riskLevelKey } from '../lib/risk';
import type {
  CellFeature,
  CellProps,
  ChatRequest,
  ChatResponse,
  CoverageCollection,
  Detection,
  Explanation,
  FiresMetadata,
  FiresSnapshot,
  Incident,
  IncidentsSnapshot,
  RiskGrid,
  RiskMetadata,
  StatusResponse,
  WeatherGrid,
} from '../types';
import type { DataProvider } from './provider';
import { HttpError, fetchJson } from './http';

type Area = Polygon | MultiPolygon;

interface FiresResponse extends FeatureCollection<Point> {
  metadata: FiresMetadata;
}
interface RiskResponse extends FeatureCollection<Area, CellProps & { scores?: number[]; risk_score?: number }> {
  metadata: Partial<RiskMetadata> & { forecast_end?: string };
}
interface WeatherResponse {
  metadata: WeatherGrid['metadata'];
  points: [number, number][];
  variables: Record<string, number[][]>;
}

const flat = (frames: number[][] | undefined, n: number, count: number) => {
  const out = new Float32Array(count * n);
  frames?.forEach((row, f) => row.forEach((v, i) => (out[f * n + i] = v ?? NaN)));
  return out;
};

export class RemoteProvider implements DataProvider {
  readonly kind = 'api' as const;
  constructor(private readonly base: string) {}

  private url(path: string, params?: Record<string, string | number>) {
    const q = params ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}` : '';
    return `${this.base}${path}${q}`;
  }

  getStatus() {
    return fetchJson<StatusResponse>(this.url('/status'), { timeoutMs: 10_000 });
  }

  async getFires(lookbackHours: number): Promise<FiresSnapshot> {
    const res = await fetchJson<FiresResponse>(this.url('/fires', { days: Math.ceil(lookbackHours / 24), hours: lookbackHours }));
    const cutoff = Date.now() - lookbackHours * HOUR_MS;
    const detections: Detection[] = (res.features ?? [])
      .filter((f) => f.geometry?.type === 'Point')
      .map((f, i) => {
        const p = (f.properties ?? {}) as Record<string, unknown>;
        return {
          id: String(f.id ?? p.id ?? `det-${i}`),
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          acquired_at: String(p.acquired_at ?? ''),
          sensor: String(p.sensor ?? 'VIIRS'),
          frp_mw: typeof p.frp_mw === 'number' ? p.frp_mw : null,
          confidence: String(p.confidence ?? 'nominal'),
          display_weight: typeof p.display_weight === 'number' ? p.display_weight : 0.5,
          daynight: (p.daynight as 'D' | 'N' | undefined) ?? null,
          incident_id: (p.incident_id as string | undefined) ?? null,
        };
      })
      .filter((d) => Date.parse(d.acquired_at) >= cutoff);
    return { metadata: res.metadata ?? { source: 'NASA FIRMS', generated_at: toIso(Date.now()) }, detections };
  }

  async getIncidents(): Promise<IncidentsSnapshot> {
    try {
      const res = await fetchJson<FeatureCollection<Area> & { metadata?: IncidentsSnapshot['metadata'] }>(this.url('/incidents'));
      const incidents: Incident[] = (res.features ?? []).map((f, i) => {
        const p = (f.properties ?? {}) as Record<string, unknown>;
        const geometry = f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') ? f.geometry : null;
        const center = (p.center as [number, number] | undefined) ?? (geometry ? centroidOfGeometry(geometry) : [0, 0]);
        return {
          id: String(f.id ?? p.id ?? `incident-${i}`),
          name: String(p.name ?? p.incident_name ?? 'Unnamed incident'),
          official: p.official !== false,
          source: String(p.source ?? res.metadata?.source ?? 'Official perimeter feed'),
          updated_at: (p.updated_at as string | undefined) ?? null,
          acres: typeof p.acres === 'number' ? p.acres : null,
          containment_pct: typeof p.containment_pct === 'number' ? p.containment_pct : null,
          status: (p.status as string | undefined) ?? null,
          url: (p.url as string | undefined) ?? null,
          geometry,
          center,
        };
      });
      return { metadata: res.metadata ?? { source: 'Official perimeter feed', generated_at: toIso(Date.now()), official_perimeter: true }, incidents };
    } catch (err) {
      // Perimeters are optional in the contract: a missing endpoint means "none available".
      if (err instanceof HttpError && err.status === 404)
        return { metadata: { source: 'Not provided', generated_at: toIso(Date.now()), official_perimeter: true }, incidents: [] };
      throw err;
    }
  }

  async getCoverage(lookbackHours: number): Promise<CoverageCollection | null> {
    try {
      return await fetchJson<CoverageCollection>(this.url('/coverage', { days: Math.ceil(lookbackHours / 24) }));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  async getRisk(): Promise<RiskGrid> {
    let res: RiskResponse;
    let hourly = true;
    try {
      res = await fetchJson<RiskResponse>(this.url('/risk/hourly', { horizon_hours: 168 }), { timeoutMs: 45_000 });
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
      // Frozen v1 endpoint: one 7-day score per cell. The timeline still works; the risk layer is constant.
      res = await fetchJson<RiskResponse>(this.url('/risk', { horizon_days: 7 }), { timeoutMs: 45_000 });
      hourly = false;
    }
    const cells = (res.features ?? []).filter((f) => f.geometry) as (Feature<Area, CellProps & { scores?: number[]; risk_score?: number }>)[];
    const md = res.metadata ?? {};
    const start = md.forecast_start ? Date.parse(md.forecast_start) : floorHour(Date.now());
    const frames = hourly ? (md.frames ?? cells[0]?.properties.scores?.length ?? 1) : 1;
    const step = hourly ? (md.step_minutes ?? 60) : 7 * 24 * 60;
    const n = cells.length;
    const scores = new Float32Array(frames * n);
    cells.forEach((c, i) => {
      const s = c.properties.scores;
      for (let f = 0; f < frames; f++) scores[f * n + i] = Math.min(1, Math.max(0, s?.[f] ?? c.properties.risk_score ?? 0));
    });
    const normalized: CellFeature[] = cells.map((c) => {
      const { scores: _s, ...props } = c.properties;
      void _s;
      const cell_id = String(props.cell_id ?? c.id);
      const center = props.lon != null && props.lat != null ? [props.lon, props.lat] : centroidOfGeometry(c.geometry);
      return { type: 'Feature', id: cell_id, geometry: c.geometry, properties: { ...props, cell_id, lon: center[0], lat: center[1], bbox: bboxOfGeometry(c.geometry) } };
    });
    return {
      metadata: {
        generated_at: md.generated_at ?? toIso(Date.now()),
        model_version: md.model_version ?? 'unknown',
        target: md.target ?? 'Wildfire hotspot-occurrence risk',
        score_type: md.score_type ?? 'uncalibrated_model_score',
        calibrated: md.calibrated ?? false,
        not_fire_spread_prediction: true,
        forecast_start: toIso(start),
        step_minutes: step,
        frames,
        source: md.source ?? (hourly ? 'FireWatch model (hourly)' : 'FireWatch model (7-day)'),
      },
      cells: normalized,
      scores,
    };
  }

  async getWeather(): Promise<WeatherGrid> {
    const res = await fetchJson<WeatherResponse>(this.url('/weather/hourly', { horizon_hours: 168 }), { timeoutMs: 45_000 });
    const n = res.points.length;
    const frames = res.metadata.frames ?? res.variables.temperature_c?.length ?? 0;
    return {
      metadata: res.metadata,
      points: res.points,
      temperature_c: flat(res.variables.temperature_c, n, frames),
      relative_humidity_pct: flat(res.variables.relative_humidity_pct, n, frames),
      wind_speed_kmh: flat(res.variables.wind_speed_kmh, n, frames),
      wind_direction_deg: flat(res.variables.wind_direction_deg, n, frames),
      wind_gust_kmh: flat(res.variables.wind_gust_kmh, n, frames),
      precipitation_mm: flat(res.variables.precipitation_mm, n, frames),
    };
  }

  async explain(cellId: string, validAtMs: number): Promise<Explanation> {
    const ex = await fetchJson<Explanation>(this.url(`/explain/${encodeURIComponent(cellId)}`, { valid_at: toIso(validAtMs) }));
    return { ...ex, risk_level: ex.risk_level ?? riskLevelKey(ex.risk_score), drivers: ex.drivers ?? [], conditions: ex.conditions ?? {} };
  }

  chat(req: ChatRequest): Promise<ChatResponse> {
    return fetchJson<ChatResponse>(this.url('/chat'), { method: 'POST', body: req, timeoutMs: 30_000 });
  }
}
