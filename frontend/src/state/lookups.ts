/** Fast spatial/temporal lookups over the loaded grids (indexes are built once per dataset). */
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { bboxContains, bboxOfGeometry, distanceKm, pointInGeometry, type BBox, type LngLat } from '../lib/geo';
import type { AreaCollection } from '../api/static';
import type { CellProps, Detection, FireGroup, PlaceResult, PointWeather, RiskGrid, WeatherGrid } from '../types';
import { frameAt } from './store';

const BUCKET = 0.25;
const bucketKey = (lon: number, lat: number) => `${Math.floor(lon / BUCKET)}:${Math.floor(lat / BUCKET)}`;

interface RiskIndex {
  byId: Map<string, number>;
  bboxes: BBox[];
  centers: LngLat[];
  buckets: Map<string, number[]>;
}
const riskIndexes = new WeakMap<RiskGrid, RiskIndex>();
export function riskIndex(grid: RiskGrid): RiskIndex {
  let idx = riskIndexes.get(grid);
  if (idx) return idx;
  const byId = new Map<string, number>();
  const bboxes: BBox[] = [];
  const centers: LngLat[] = [];
  const buckets = new Map<string, number[]>();
  grid.cells.forEach((c, i) => {
    byId.set(c.properties.cell_id, i);
    const b = bboxOfGeometry(c.geometry);
    bboxes.push(b);
    centers.push(
      typeof c.properties.lon === 'number' && typeof c.properties.lat === 'number'
        ? [c.properties.lon, c.properties.lat]
        : [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2],
    );
    for (let x = Math.floor(b[0] / BUCKET); x <= Math.floor(b[2] / BUCKET); x++)
      for (let y = Math.floor(b[1] / BUCKET); y <= Math.floor(b[3] / BUCKET); y++) {
        const k = `${x}:${y}`;
        const list = buckets.get(k);
        if (list) list.push(i);
        else buckets.set(k, [i]);
      }
  });
  idx = { byId, bboxes, centers, buckets };
  riskIndexes.set(grid, idx);
  return idx;
}

export function cellIndexAt(grid: RiskGrid, p: LngLat): number {
  const idx = riskIndex(grid);
  for (const i of idx.buckets.get(bucketKey(p[0], p[1])) ?? [])
    if (bboxContains(idx.bboxes[i], p) && pointInGeometry(p, grid.cells[i].geometry)) return i;
  return -1;
}

export const riskFrame = (grid: RiskGrid, t: number) =>
  frameAt(t, grid.metadata.forecast_start, grid.metadata.step_minutes, grid.metadata.frames);
export const scoreAt = (grid: RiskGrid, cell: number, t: number) => grid.scores[riskFrame(grid, t) * grid.cells.length + cell];

/** One value per hour on the timeline axis (frames are repeated when the model step is coarser). */
export function seriesForCells(grid: RiskGrid, cells: number[], hours: number[], reduce: 'max' | 'mean' = 'max'): number[] {
  const n = grid.cells.length;
  return hours.map((t) => {
    const f = riskFrame(grid, t);
    let acc = 0, count = 0;
    for (const c of cells) {
      const v = grid.scores[f * n + c];
      if (!Number.isFinite(v)) continue; // not loaded / missing in the artifact
      acc = reduce === 'max' ? Math.max(acc, v) : acc + v;
      count++;
    }
    if (!count) return NaN;
    return reduce === 'max' ? acc : acc / count;
  });
}

const statewide = new WeakMap<RiskGrid, Float32Array>();
/** Share of cells at High or above per model frame (timeline background trend). */
export function statewideShare(grid: RiskGrid, threshold = 0.4): Float32Array {
  let out = statewide.get(grid);
  if (out) return out;
  const n = grid.cells.length;
  out = new Float32Array(grid.metadata.frames);
  for (let f = 0; f < grid.metadata.frames; f++) {
    let c = 0;
    for (let i = 0; i < n; i++) if (grid.scores[f * n + i] >= threshold) c++;
    out[f] = c / Math.max(1, n);
  }
  statewide.set(grid, out);
  return out;
}

// ---- naming ------------------------------------------------------------------------
let countyShapes: AreaCollection | null = null;
export const setCountyShapes = (fc: AreaCollection) => (countyShapes = fc);

/** Nearest named community (prefers incorporated and larger places) within `maxKm`. */
export function nearestPlaceName(index: PlaceResult[] | null, p: LngLat, maxKm = 30): string | null {
  if (!index) return null;
  let best: string | null = null, bd = Infinity;
  for (const pl of index) {
    if (pl.type === 'zip' || pl.type === 'county') continue;
    if (Math.abs(pl.center[1] - p[1]) > 0.35 || Math.abs(pl.center[0] - p[0]) > 0.45) continue;
    const d = distanceKm(p, pl.center);
    const score = d - (pl.type === 'cdp' ? 0 : 2) - Math.log10((pl.population ?? 0) + 1);
    if (d <= maxKm && score < bd) [bd, best] = [score, pl.name];
  }
  return best;
}
export function countyAt(p: LngLat): string | null {
  const hit = countyShapes?.features.find((f) => pointInGeometry(p, f.geometry));
  return hit?.properties.county ?? null;
}
/** County and nearby community for a point; uses the cell's own properties when the grid has them. */
export function describePoint(index: PlaceResult[] | null, p: LngLat, props?: CellProps | null) {
  return {
    near: (props?.near as string | null | undefined) ?? nearestPlaceName(index, p),
    county: (props?.county as string | null | undefined) ?? countyAt(p),
  };
}

// ---- places ------------------------------------------------------------------------
export function cellsForPlace(grid: RiskGrid, place: PlaceResult, boundary: Feature<Polygon | MultiPolygon> | null): number[] {
  const idx = riskIndex(grid);
  const [w, s, e, n] = place.bbox;
  const out: number[] = [];
  if (boundary) {
    for (let x = Math.floor(w / BUCKET); x <= Math.floor(e / BUCKET); x++)
      for (let y = Math.floor(s / BUCKET); y <= Math.floor(n / BUCKET); y++)
        for (const i of idx.buckets.get(`${x}:${y}`) ?? []) {
          if (out.includes(i)) continue;
          if (bboxContains(place.bbox, idx.centers[i]) && pointInGeometry(idx.centers[i], boundary.geometry)) out.push(i);
        }
  }
  if (!out.length) {
    const i = cellIndexAt(grid, place.center);
    if (i >= 0) out.push(i);
    else {
      // Place centre falls in a gap (coast, border): use the nearest cell.
      let best = -1, bd = Infinity;
      idx.centers.forEach((c, k) => {
        const d = distanceKm(c, place.center);
        if (d < bd) [bd, best] = [d, k];
      });
      if (best >= 0 && bd < 25) out.push(best);
    }
  }
  return out;
}

export function summarizeCells(grid: RiskGrid, cells: number[], t: number) {
  const f = riskFrame(grid, t);
  const n = grid.cells.length;
  let max = NaN, maxCell = cells[0] ?? -1, sum = 0, shaded = 0, known = 0;
  for (const c of cells) {
    const v = grid.scores[f * n + c];
    if (!Number.isFinite(v)) continue;
    known++;
    sum += v;
    if (v >= 0.2) shaded++;
    if (!(v <= max)) [max, maxCell] = [v, c];
  }
  return { max, maxCell, mean: known ? sum / known : NaN, shadedShare: shaded / Math.max(1, known), count: cells.length, known };
}

// ---- weather ---------------------------------------------------------------------
const weatherBuckets = new WeakMap<WeatherGrid, Map<string, number[]>>();
export function nearestWeatherPoint(grid: WeatherGrid, p: LngLat, maxKm = 40): number {
  let buckets = weatherBuckets.get(grid);
  if (!buckets) {
    buckets = new Map();
    grid.points.forEach(([x, y], i) => {
      const k = bucketKey(x, y);
      const list = buckets!.get(k);
      if (list) list.push(i);
      else buckets!.set(k, [i]);
    });
    weatherBuckets.set(grid, buckets);
  }
  let best = -1, bd = Infinity;
  const bx = Math.floor(p[0] / BUCKET), by = Math.floor(p[1] / BUCKET);
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = -2; dy <= 2; dy++)
      for (const i of buckets.get(`${bx + dx}:${by + dy}`) ?? []) {
        const d = distanceKm(p, grid.points[i]);
        if (d < bd) [bd, best] = [d, i];
      }
  return bd <= maxKm ? best : -1;
}
export const weatherFrame = (grid: WeatherGrid, t: number) => {
  const f = Math.floor((t - Date.parse(grid.metadata.forecast_start)) / (grid.metadata.step_minutes * 60_000));
  return Number.isFinite(f) && f >= 0 && f < grid.metadata.frames ? f : -1;
};
export function weatherAtIndex(grid: WeatherGrid, i: number, t: number): PointWeather {
  const k = weatherFrame(grid, t) * grid.points.length + i;
  return {
    fetched_at: grid.metadata.fetched_at,
    cache_status: grid.metadata.cache_status,
    source: grid.metadata.source,
    temperature_c: grid.temperature_c[k],
    relative_humidity_pct: grid.relative_humidity_pct[k],
    wind_speed_kmh: grid.wind_speed_kmh[k],
    wind_direction_deg: grid.wind_direction_deg[k],
    wind_gust_kmh: grid.wind_gust_kmh[k],
    precipitation_mm: grid.precipitation_mm[k],
  };
}
/** Inverse-distance-weighted wind at any point (for dense arrows at city zoom). */
export function windAt(grid: WeatherGrid, p: LngLat, t: number, maxKm = 45): { speed: number; dir: number } | null {
  if (weatherFrame(grid, t) < 0) return null;
  if (nearestWeatherPoint(grid, p, maxKm) < 0) return null;
  const buckets = weatherBuckets.get(grid)!;
  const k = weatherFrame(grid, t) * grid.points.length;
  const bx = Math.floor(p[0] / BUCKET), by = Math.floor(p[1] / BUCKET);
  let W = 0, S = 0, U = 0, V = 0;
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = -2; dy <= 2; dy++)
      for (const i of buckets.get(`${bx + dx}:${by + dy}`) ?? []) {
        const d = distanceKm(p, grid.points[i]);
        if (d > maxKm) continue;
        const w = 1 / (d * d + 4);
        const s = grid.wind_speed_kmh[k + i];
        const r = (grid.wind_direction_deg[k + i] * Math.PI) / 180;
        W += w;
        S += w * s;
        U += w * -Math.sin(r);
        V += w * -Math.cos(r);
      }
  if (!W) return null;
  return { speed: S / W, dir: ((Math.atan2(-U, -V) * 180) / Math.PI + 360) % 360 };
}

export function weatherAtPoint(grid: WeatherGrid | null, p: LngLat, t: number): PointWeather | null {
  if (!grid || weatherFrame(grid, t) < 0) return null;
  const i = nearestWeatherPoint(grid, p);
  return i < 0 ? null : weatherAtIndex(grid, i, t);
}

// ---- fires -----------------------------------------------------------------------
export interface NearbyGroup {
  group: FireGroup;
  km: number;
}
export function groupsNear(groups: FireGroup[], p: LngLat, km: number): NearbyGroup[] {
  return groups
    .map((group) => ({ group, km: distanceKm(p, group.center) }))
    .filter((g) => g.km <= km)
    .sort((a, b) => a.km - b.km);
}
export function detectionsWithin(dets: Detection[], p: LngLat, km: number): Detection[] {
  const dLat = km / 110.57, dLon = km / 85;
  return dets.filter((d) => Math.abs(d.lat - p[1]) <= dLat && Math.abs(d.lon - p[0]) <= dLon && distanceKm(p, [d.lon, d.lat]) <= km);
}
