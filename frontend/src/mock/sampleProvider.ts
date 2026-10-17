/**
 * Offline SAMPLE data provider. Generates detections, an hourly 7-day risk forecast with exact
 * per-feature contributions, and an hourly weather/wind grid — all in the browser, relative to
 * the current hour. Everything it returns is flagged `sample` and labelled in the UI.
 */
import type { MultiPolygon } from 'geojson';
import type { DataProvider } from '../api/provider';
import { HttpError } from '../api/http';
import { loadCaBoundary, loadSampleCells } from '../api/static';
import { distanceKm, pointInGeometry, type LngLat } from '../lib/geo';
import { riskLevelKey } from '../lib/risk';
import { HOUR_MS, floorHour, toIso } from '../lib/time';
import type {
  CellFeature,
  ChatResponse,
  CoverageCollection,
  Explanation,
  FiresSnapshot,
  IncidentsSnapshot,
  RiskGrid,
  StatusResponse,
  WeatherGrid,
} from '../types';
import { generateSampleFires, type SampleFireData } from './fires';
import { MODEL_VERSION, contributions, score, type ModelInputs } from './model';
import { daysSinceRain, fuelMoisture, makeScenario, rainRate, weatherAt, type Env, type Scenario } from './weather';

const FRAMES = 168;
const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

interface CellStatic {
  env: Env;
  veg: number;
  slope: number;
  hist: number;
  active: number;
}

export class SampleProvider implements DataProvider {
  readonly kind = 'sample' as const;
  private readonly start: number;
  private readonly createdAt: number;
  private readonly sc: Scenario;
  private initialFires: SampleFireData;
  private prepared: Promise<{ cells: CellFeature[]; statics: CellStatic[]; index: Map<string, number> }> | null = null;
  private riskPromise: Promise<RiskGrid> | null = null;
  private weatherPromise: Promise<WeatherGrid> | null = null;

  constructor(now = Date.now()) {
    this.createdAt = now;
    this.start = floorHour(now);
    this.sc = makeScenario(this.start);
    this.initialFires = generateSampleFires(now, now, this.sc.seed);
  }

  /** Ignition times stay fixed for the session, so fires grow and new overpasses appear as time passes. */
  private firesAt(now: number): SampleFireData {
    if (now - this.createdAt < 60_000) return this.initialFires;
    return generateSampleFires(this.createdAt, now, this.sc.seed);
  }

  async getStatus(): Promise<StatusResponse> {
    return {
      status: 'ok',
      runtime_arch: 'browser (sample data)',
      model_version: MODEL_VERSION,
      snapshots: {
        fires_at: toIso(this.initialFires.generatedAt),
        risk_at: toIso(this.start - 25 * 60_000),
        weather_at: toIso(this.start - 40 * 60_000),
      },
      data_mode: 'fixture',
      api_contract_version: 1,
    };
  }

  async getFires(lookbackHours: number): Promise<FiresSnapshot> {
    const now = Date.now();
    const data = this.firesAt(now);
    const cutoff = now - lookbackHours * HOUR_MS;
    return {
      metadata: {
        source: 'SAMPLE detections (synthetic, modelled on NASA FIRMS VIIRS)',
        generated_at: toIso(data.generatedAt),
        stale: false,
        observation_type: 'thermal_anomaly',
        not_fire_perimeter: true,
        lookback_hours: lookbackHours,
      },
      detections: data.detections.filter((d) => Date.parse(d.acquired_at) >= cutoff),
    };
  }

  async getIncidents(): Promise<IncidentsSnapshot> {
    return {
      metadata: { source: 'SAMPLE incident records', generated_at: toIso(this.initialFires.generatedAt), official_perimeter: true, sample: true },
      incidents: this.initialFires.incidents,
    };
  }

  async getCoverage(): Promise<CoverageCollection | null> {
    return null; // derived client-side from detections
  }

  private prepare() {
    this.prepared ??= (async () => {
      const fc = await loadSampleCells();
      const cells = fc.features as CellFeature[];
      const dets = this.initialFires.detections;
      const statics = cells.map((c): CellStatic => {
        const p = c.properties as unknown as Record<string, number & string>;
        const center: LngLat = [p.lon, p.lat];
        let active = 0;
        for (const d of dets) {
          if (Math.abs(d.lat - center[1]) > 0.16 || Math.abs(d.lon - center[0]) > 0.2) continue;
          if (distanceKm(center, [d.lon, d.lat]) <= 15) active++;
        }
        return {
          env: { lon: p.lon, lat: p.lat, elev: p.elev_m, coastKm: p.coast_km, fuel: p.fuel, ocean: false },
          veg: p.veg_density,
          slope: p.slope_deg,
          hist: p.hist_count,
          active,
        };
      });
      return { cells, statics, index: new Map(cells.map((c, i) => [c.properties.cell_id, i])) };
    })();
    return this.prepared;
  }

  private inputs(s: CellStatic, t: number): { x: ModelInputs; w: ReturnType<typeof weatherAt> } {
    const w = weatherAt(s.env, t, this.sc);
    let p6 = 0;
    for (let k = 0; k < 6; k++) p6 += rainRate(s.env, t - k * HOUR_MS, this.sc);
    const x: ModelInputs = {
      wind_speed_10m: w.wind_speed_kmh,
      wind_gust_10m: w.wind_gust_kmh,
      relative_humidity_2m: w.relative_humidity_pct,
      temperature_2m: w.temperature_c,
      precipitation_6h: p6,
      dead_fuel_moisture: fuelMoisture(w.temperature_c, w.relative_humidity_pct, p6),
      days_since_rain: daysSinceRain(s.env, t, this.sc),
      vegetation_density: s.veg,
      fuel_type: s.env.fuel,
      slope: s.slope,
      hotspot_history: s.hist,
      active_hotspots_nearby: s.active,
    };
    return { x, w };
  }

  getRisk(): Promise<RiskGrid> {
    this.riskPromise ??= (async () => {
      const { cells, statics } = await this.prepare();
      const n = cells.length;
      const scores = new Float32Array(FRAMES * n);
      for (let i = 0; i < n; i++) {
        const s = statics[i];
        for (let f = 0; f < FRAMES; f++) scores[f * n + i] = score(this.inputs(s, this.start + f * HOUR_MS).x);
        if (i % 300 === 299) await yieldToMain();
      }
      return {
        metadata: {
          generated_at: toIso(this.start - 25 * 60_000),
          model_version: MODEL_VERSION,
          target: 'Relative likelihood of ≥1 qualifying satellite hotspot in the cell during the valid hour',
          score_type: 'uncalibrated_model_score',
          calibrated: false,
          not_fire_spread_prediction: true,
          forecast_start: toIso(this.start),
          step_minutes: 60,
          frames: FRAMES,
          source: 'SAMPLE forecast generated in the browser (demo model)',
          sample: true,
        },
        cells,
        scores,
      };
    })();
    return this.riskPromise;
  }

  getWeather(): Promise<WeatherGrid> {
    this.weatherPromise ??= (async () => {
      const [{ cells, statics }, ca] = await Promise.all([this.prepare(), loadCaBoundary()]);
      const caGeom = ca.features[0].geometry as MultiPolygon;
      // West-most mainland coast per 0.1° latitude band → ocean test outside the CA polygon.
      const mainland = caGeom.coordinates.reduce((a, b) => (b[0].length > a[0].length ? b : a));
      const west = new Map<number, number>();
      for (const [x, y] of mainland[0]) {
        const band = Math.round(y * 10);
        west.set(band, Math.min(west.get(band) ?? Infinity, x));
      }
      const westAt = (lat: number) => {
        for (let d = 0; d < 6; d++) {
          const v = west.get(Math.round(lat * 10) + d) ?? west.get(Math.round(lat * 10) - d);
          if (v != null) return v;
        }
        return -124.4;
      };
      const isOcean = ([lon, lat]: LngLat) => {
        if (lat > 42) return lon < -124.35;
        if (lat < 32.53) return lon < -117.12 + (32.53 - lat) * 0.55;
        return lon < westAt(lat) - 0.03;
      };
      const coastal = statics.filter((s) => s.env.coastKm <= 10).map((s) => [s.env.lon, s.env.lat] as LngLat);
      const bucket = new Map<string, number[]>();
      statics.forEach((s, i) => {
        const k = `${Math.round(s.env.lon * 4)}:${Math.round(s.env.lat * 4)}`;
        (bucket.get(k) ?? bucket.set(k, []).get(k)!).push(i);
      });

      const points: LngLat[] = [];
      const envs: Env[] = [];
      for (let lat = 31.75; lat <= 42.75 + 1e-9; lat += 0.25)
        for (let lon = -126.5; lon <= -113.5 + 1e-9; lon += 0.25) {
          const p: LngLat = [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100];
          if (pointInGeometry(p, caGeom)) {
            let best = -1, bd = Infinity;
            for (let dx = -1; dx <= 1; dx++)
              for (let dy = -1; dy <= 1; dy++)
                for (const i of bucket.get(`${Math.round(p[0] * 4) + dx}:${Math.round(p[1] * 4) + dy}`) ?? []) {
                  const d = distanceKm(p, [statics[i].env.lon, statics[i].env.lat]);
                  if (d < bd) [bd, best] = [d, i];
                }
            if (best < 0) continue;
            points.push(p);
            envs.push({ ...statics[best].env, lon: p[0], lat: p[1] });
          } else if (isOcean(p)) {
            let coastKm = Infinity;
            for (const c of coastal) if (Math.abs(c[1] - p[1]) < 2) coastKm = Math.min(coastKm, distanceKm(p, c));
            points.push(p);
            envs.push({ lon: p[0], lat: p[1], elev: 0, coastKm: Number.isFinite(coastKm) ? coastKm : 200, fuel: 'water', ocean: true });
          }
        }
      void cells;
      const m = points.length;
      const arr = () => new Float32Array(FRAMES * m);
      const out = { t: arr(), rh: arr(), ws: arr(), wd: arr(), wg: arr(), pr: arr() };
      for (let j = 0; j < m; j++) {
        for (let f = 0; f < FRAMES; f++) {
          const w = weatherAt(envs[j], this.start + f * HOUR_MS, this.sc);
          const k = f * m + j;
          out.t[k] = w.temperature_c;
          out.rh[k] = w.relative_humidity_pct;
          out.ws[k] = w.wind_speed_kmh;
          out.wd[k] = w.wind_direction_deg;
          out.wg[k] = w.wind_gust_kmh;
          out.pr[k] = w.precipitation_mm;
        }
        if (j % 400 === 399) await yieldToMain();
      }
      return {
        metadata: {
          generated_at: toIso(this.start - 40 * 60_000),
          source: 'SAMPLE weather (synthetic; stands in for Open-Meteo forecast)',
          forecast_start: toIso(this.start),
          step_minutes: 60,
          frames: FRAMES,
          sample: true,
        },
        points,
        temperature_c: out.t,
        relative_humidity_pct: out.rh,
        wind_speed_kmh: out.ws,
        wind_direction_deg: out.wd,
        wind_gust_kmh: out.wg,
        precipitation_mm: out.pr,
      };
    })();
    return this.weatherPromise;
  }

  async explain(cellId: string, validAtMs: number): Promise<Explanation> {
    const { statics, index } = await this.prepare();
    const i = index.get(cellId);
    if (i == null) throw new HttpError('not_found', `Unknown cell ${cellId}`, 404);
    const f = Math.max(0, Math.min(FRAMES - 1, Math.round((validAtMs - this.start) / HOUR_MS)));
    const t = this.start + f * HOUR_MS;
    const { x, w } = this.inputs(statics[i], t);
    const c = contributions(x);
    return {
      cell_id: cellId,
      valid_at: toIso(t),
      model_version: MODEL_VERSION,
      risk_score: c.score,
      risk_level: riskLevelKey(c.score),
      score_type: 'uncalibrated_model_score',
      base_value: c.base,
      raw_score: c.raw,
      drivers: c.drivers,
      conditions: {
        temperature_c: w.temperature_c,
        relative_humidity_pct: w.relative_humidity_pct,
        wind_speed_kmh: w.wind_speed_kmh,
        wind_direction_deg: w.wind_direction_deg,
        wind_gust_kmh: w.wind_gust_kmh,
        precipitation_mm: w.precipitation_mm,
        fuel_moisture_pct: x.dead_fuel_moisture,
        days_since_rain: x.days_since_rain,
        fuel_type: x.fuel_type,
        vegetation_density: x.vegetation_density,
        elevation_m: statics[i].env.elev,
        slope_deg: statics[i].slope,
      },
      sample: true,
    };
  }

  async chat(): Promise<ChatResponse> {
    throw new HttpError('not_supported', 'Sample mode answers with the offline assistant', 501);
  }
}
