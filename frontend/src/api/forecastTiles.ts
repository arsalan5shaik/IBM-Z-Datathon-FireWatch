/**
 * Backend risk loader. The API serves the 3 km grid as bbox + hour slices
 * (GET /api/v1/forecasts/risk, ≤ MAX_RESPONSE_CELLS per request, 422 instead of truncating),
 * so the frontend requests fixed tiles for the visible area and selected hour, and merges them
 * into one sparse RiskGrid (NaN = not loaded / missing). Per-cell 168-hour histories come from
 * GET /api/v1/forecasts/cell/{cell_id}.
 */
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { HOUR_MS, toIso } from '../lib/time';
import type { BBox } from '../lib/geo';
import type { CellFeature, RiskGrid, RiskMetadata } from '../types';
import { HttpError, fetchJson } from './http';

const FRAMES = 168;
/** ~1° × 0.8° ≈ 90 × 90 km ≈ 900 cells of 3 km — comfortably under the default 2,000-cell cap. */
const TILE_W = 1.0;
const TILE_H = 0.8;
const CA = { w: -124.6, s: 32.4, e: -114.0, n: 42.1 };
const CONCURRENCY = 4;

type Area = Polygon | MultiPolygon;
interface RiskProps {
  cell_id: string;
  risk_score: number | null;
  risk_category?: string;
  score_type?: string;
  target_type?: string;
  forecast_hour?: string;
}
interface RiskResponse extends FeatureCollection<Area, RiskProps> {
  metadata?: Record<string, unknown>;
}
interface HistoryResponse {
  cell_id: string;
  metadata?: Record<string, unknown>;
  hours: { forecast_hour: string; risk_score: number | null; missing?: boolean; score_type?: string }[];
}

/** Existing backend contract is normalized 0–1; never guess scale from a number. */
export function apiRiskScore(value: unknown): number {
  if (value === null) return NaN;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new HttpError('forecast_score_scale_mismatch', 'Forecast score scale differs from the current 0–1 API contract; ML/backend normalization must be agreed');
  return value;
}

export type ViewCoverage = 'ok' | 'zoom-in' | 'loading' | 'missing-hour' | 'error';

export class ForecastTiles {
  private start: number;
  publishedHours: string[] = [];

  alignWindow(start: number) { if (start !== this.start) this.reset(start); }
  private meta: Partial<RiskMetadata> = {};
  private cells: CellFeature[] = [];
  private index = new Map<string, number>();
  private values = new Map<number, Map<number, number>>();
  private tiles = new Map<string, 'loading' | 'done' | 'missing' | 'error'>();
  private histories = new Set<string>();
  private queue: (() => Promise<void>)[] = [];
  /** Background (prefetch) jobs run only when no visible-area job is waiting. */
  private lowQueue: (() => Promise<void>)[] = [];
  /** Tiles of the last visible view (buffer bar + prefetch). */
  private lastKeys: [number, number][] = [];
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly base: string,
    start: number,
    private readonly onChange: (grid: RiskGrid) => void,
  ) {
    this.start = start;
  }

  private url(path: string, params: Record<string, string>) {
    return `${this.base}${path}?${new URLSearchParams(params)}`;
  }
  private frameOf(t: number) {
    return Math.round((t - this.start) / HOUR_MS);
  }

  snapshot(): RiskGrid {
    const n = this.cells.length;
    const scores = new Float32Array(FRAMES * n).fill(NaN);
    for (const [f, row] of this.values) for (const [i, v] of row) scores[f * n + i] = v;
    return {
      metadata: {
        generated_at: this.meta.generated_at ?? '',
        model_version: this.meta.model_version ?? 'unknown',
        target: this.meta.target ?? 'Wildfire activity risk (backend)',
        score_type: this.meta.score_type ?? 'relative_risk',
        calibrated: false,
        not_fire_spread_prediction: true,
        forecast_start: toIso(this.start),
        step_minutes: 60,
        frames: FRAMES,
        source: this.meta.source ?? 'FireWatch API',
        sparse: true,
        available_hours: this.publishedHours.length ? this.publishedHours.slice() : [...this.values.entries()]
          .filter(([, row]) => [...row.values()].some(Number.isFinite))
          .map(([frame]) => toIso(this.start + frame * HOUR_MS)).sort(),
        grid_version: this.meta.grid_version,
        published_at: this.meta.published_at,
      },
      cells: this.cells.slice(),
      scores,
    };
  }

  private changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onChange(this.snapshot()), 80);
  }

  private absorbMetadata(md: Record<string, unknown> | undefined, sample?: RiskProps) {
    if (!md) return;
    const str = (k: string) => (typeof md[k] === 'string' ? (md[k] as string) : undefined);
    const windowStart = str('active_window_start');
    if (windowStart) {
      const ws = Date.parse(windowStart);
      if (Number.isFinite(ws) && ws !== this.start) {
        // Re-key everything to the authoritative window.
        const shift = Math.round((this.start - ws) / HOUR_MS);
        const moved = new Map<number, Map<number, number>>();
        for (const [f, row] of this.values) if (f + shift >= 0 && f + shift < FRAMES) moved.set(f + shift, row);
        this.values = moved;
        this.start = ws;
      }
    }
    this.meta = {
      ...this.meta,
      model_version: str('model_version') ?? this.meta.model_version,
      grid_version: str('grid_version') ?? this.meta.grid_version,
      published_at: str('published_at') ?? this.meta.published_at,
      generated_at: str('generated_at_max') ?? str('published_at') ?? this.meta.generated_at,
      source: str('source') === 'mock_fixture' ? 'FireWatch API (fixture data)' : str('source') ? `FireWatch API (${str('source')})` : this.meta.source,
      score_type: sample?.score_type ?? this.meta.score_type,
      target: sample?.target_type ? `Target: ${sample.target_type.replace(/_/g, ' ')}` : this.meta.target,
    };
  }

  private addCells(features: Feature<Area, RiskProps>[], frame: number | null) {
    for (const feature of features) apiRiskScore(feature.properties?.risk_score);
    for (const f of features) {
      const id = String(f.properties?.cell_id ?? f.id);
      if (!f.geometry) continue;
      let i = this.index.get(id);
      if (i == null) {
        i = this.cells.length;
        this.index.set(id, i);
        this.cells.push({ type: 'Feature', id, geometry: f.geometry, properties: { cell_id: id } });
      }
      if (frame != null && frame >= 0 && frame < FRAMES) {
        let row = this.values.get(frame);
        if (!row) this.values.set(frame, (row = new Map()));
        const v = f.properties?.risk_score;
        row.set(i, apiRiskScore(v));
      }
    }
  }

  private pump() {
    while (this.active < CONCURRENCY && (this.queue.length || this.lowQueue.length)) {
      const job = (this.queue.length ? this.queue : this.lowQueue).shift()!;
      this.active++;
      void job().finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private tileBox(tx: number, ty: number): BBox {
    return [tx * TILE_W, ty * TILE_H, (tx + 1) * TILE_W, (ty + 1) * TILE_H];
  }

  private async fetchTile(box: BBox, hourIso: string, depth = 0): Promise<'done' | 'missing'> {
    const bbox = box.map((v) => v.toFixed(4)).join(',');
    try {
      const res = await fetchJson<RiskResponse>(this.url('/forecasts/risk', { bbox, hour: hourIso }), { timeoutMs: 30_000 });
      this.absorbMetadata(res.metadata, res.features?.[0]?.properties);
      this.addCells(res.features ?? [], this.frameOf(Date.parse(hourIso)));
      return 'done';
    } catch (err) {
      if (err instanceof HttpError && err.status === 422 && err.code === 'response_too_large' && depth < 3) {
        // Dense area: split into quadrants rather than accept a truncated answer.
        const [w, s, e, n] = box;
        const mx = (w + e) / 2, my = (s + n) / 2;
        const parts: BBox[] = [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]];
        const out = await Promise.all(parts.map((p) => this.fetchTile(p, hourIso, depth + 1)));
        return out.includes('done') ? 'done' : 'missing';
      }
      if (err instanceof HttpError && err.status === 404) return 'missing';
      throw err;
    }
  }

  /** Probe readiness with one tile (throws on 503 forecast_not_ready / network errors). */
  async probe(center: [number, number]) {
    const tx = Math.floor(center[0] / TILE_W), ty = Math.floor(center[1] / TILE_H);
    const hour = toIso(this.start + Math.max(0, this.frameOf(Math.floor(Date.now() / HOUR_MS) * HOUR_MS)) * HOUR_MS);
    const key = `${tx}:${ty}@${hour}`;
    this.tiles.set(key, 'loading');
    const state = await this.fetchTile(this.tileBox(tx, ty), hour);
    this.tiles.set(key, state);
    this.changed();
  }

  /** Load what's needed to draw `bbox` at hour `t`. */
  ensureView(bbox: BBox, t: number, maxTiles = 16): ViewCoverage {
    const f = this.frameOf(t);
    if (f < 0 || f >= FRAMES) return 'missing-hour';
    const hour = toIso(this.start + f * HOUR_MS);
    const w = Math.max(bbox[0], CA.w), s = Math.max(bbox[1], CA.s), e = Math.min(bbox[2], CA.e), n = Math.min(bbox[3], CA.n);
    if (w >= e || s >= n) return 'ok';
    const keys: [number, number][] = [];
    for (let tx = Math.floor(w / TILE_W); tx * TILE_W < e; tx++)
      for (let ty = Math.floor(s / TILE_H); ty * TILE_H < n; ty++) keys.push([tx, ty]);
    if (keys.length > maxTiles) return 'zoom-in';
    if (maxTiles <= 16) this.lastKeys = keys;
    let loading = false, missing = 0, errors = 0;
    for (const [tx, ty] of keys) {
      const key = `${tx}:${ty}@${hour}`;
      const state = this.tiles.get(key);
      if (state === 'done') continue;
      if (state === 'missing') {
        missing++;
        continue;
      }
      if (state === 'error') {
        errors++;
        continue;
      }
      loading = true;
      if (state === 'loading') continue;
      this.tiles.set(key, 'loading');
      this.queue.push(async () => {
        try {
          this.tiles.set(key, await this.fetchTile(this.tileBox(tx, ty), hour));
        } catch {
          this.tiles.set(key, 'error');
          // Allow a retry later.
          setTimeout(() => this.tiles.get(key) === 'error' && this.tiles.delete(key), 30_000);
        }
        this.changed();
      });
    }
    this.pump();
    if (loading) return 'loading';
    if (errors) return 'error';
    if (missing === keys.length) return 'missing-hour';
    return 'ok';
  }

  /**
   * Quietly load the visible tiles for the next `hours` forecast hours (and one hour back), so
   * stepping or playing never waits on the network. Uses the background queue.
   */
  prefetch(t: number, hours = 3) {
    const f0 = this.frameOf(t);
    for (const df of [1, -1, ...Array.from({ length: Math.max(0, hours - 1) }, (_, k) => k + 2)]) {
      const f = f0 + df;
      if (f < 0 || f >= FRAMES) continue;
      const hour = toIso(this.start + f * HOUR_MS);
      if (this.publishedHours.length && !this.publishedHours.includes(hour)) continue;
      for (const [tx, ty] of this.lastKeys) {
        const key = `${tx}:${ty}@${hour}`;
        if (this.tiles.has(key)) continue;
        this.tiles.set(key, 'loading');
        this.lowQueue.push(async () => {
          try {
            this.tiles.set(key, await this.fetchTile(this.tileBox(tx, ty), hour));
          } catch {
            this.tiles.delete(key);
          }
          this.changed();
        });
      }
    }
    this.pump();
  }

  /** Per-hour load state of the visible tiles: 0 unknown, 1 loading, 2 loaded, 3 not published. */
  hourStates(): Uint8Array {
    const out = new Uint8Array(FRAMES);
    if (!this.lastKeys.length) return out;
    for (let f = 0; f < FRAMES; f++) {
      const hour = toIso(this.start + f * HOUR_MS);
      let done = 0, missing = 0, loading = 0;
      for (const [tx, ty] of this.lastKeys) {
        const st = this.tiles.get(`${tx}:${ty}@${hour}`);
        if (st === 'done') done++;
        else if (st === 'missing') missing++;
        else if (st === 'loading') loading++;
      }
      out[f] = done + missing === this.lastKeys.length ? (done ? 2 : 3) : loading || done ? 1 : 0;
    }
    return out;
  }

  /** All 168 hours for one cell (sparkline, peak-hour questions). */
  async ensureHistory(cellId: string) {
    if (this.histories.has(cellId) || !this.index.has(cellId)) return;
    this.histories.add(cellId);
    try {
      // Reads up to 168 artifacts server-side: can be slow.
      const res = await fetchJson<HistoryResponse>(`${this.base}/forecasts/cell/${encodeURIComponent(cellId)}`, { timeoutMs: 90_000 });
      this.absorbMetadata(res.metadata);
      const i = this.index.get(cellId);
      if (i == null) return;
      for (const h of res.hours ?? []) {
        const f = this.frameOf(Date.parse(h.forecast_hour));
        if (f < 0 || f >= FRAMES) continue;
        let row = this.values.get(f);
        if (!row) this.values.set(f, (row = new Map()));
        row.set(i, h.missing ? NaN : apiRiskScore(h.risk_score));
      }
      this.changed();
    } catch {
      this.histories.delete(cellId);
    }
  }

  reset(start: number) {
    this.start = start;
    this.publishedHours = [];
    this.cells = [];
    this.index.clear();
    this.values.clear();
    this.tiles.clear();
    this.histories.clear();
    this.queue = [];
    this.lowQueue = [];
    this.lastKeys = [];
    this.changed();
  }
}
