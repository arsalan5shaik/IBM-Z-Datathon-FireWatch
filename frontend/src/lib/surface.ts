/**
 * Statewide level-of-detail views of the risk grid (visual smoothing only — the model output is
 * the per-cell grid shown when zoomed in):
 *   - surface: inverse-distance-weighted raster of cell centres traced into stacked contour bands;
 *   - coarse:  cells binned into ~3× larger hexagons holding the maximum member score.
 * Pure functions: they run in the compute worker (workers/compute.worker.ts) or synchronously.
 */
import { contours } from 'd3-contour';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { RISK_ALPHA, rampRgb, rgba } from './palette';

const RAD = Math.PI / 180;
const KM_PER_DEG_LAT = 110.57;

export interface SurfacePrep {
  nx: number;
  ny: number;
  w: number;
  n: number;
  res: number;
  k: number;
  /** k neighbour cell indices per pixel (−1 = none). */
  idx: Int32Array;
  wts: Float32Array;
}

/**
 * Precompute, once per grid, which cells influence each raster pixel. `centers` is
 * [lon0, lat0, lon1, lat1, …]. Pixels farther than `maxKm` from every cell stay empty (ocean,
 * out of state), so the surface never invents values beyond the grid.
 */
export function prepareSurface(centers: Float32Array, bbox: [number, number, number, number] = [-124.6, 32.4, -114.0, 42.1], res = 0.07, maxKm = 16, k = 4): SurfacePrep {
  const [w, s, e, n] = bbox;
  const nx = Math.ceil((e - w) / res) + 1;
  const ny = Math.ceil((n - s) / res) + 1;
  const count = centers.length / 2;
  // Bucket cells on a 0.25° grid for neighbour search.
  const B = 0.25;
  const buckets = new Map<number, number[]>();
  const key = (bx: number, by: number) => bx * 10_000 + by;
  for (let i = 0; i < count; i++) {
    const k2 = key(Math.floor(centers[2 * i] / B), Math.floor(centers[2 * i + 1] / B));
    const list = buckets.get(k2);
    if (list) list.push(i);
    else buckets.set(k2, [i]);
  }
  const idx = new Int32Array(nx * ny * k).fill(-1);
  const wts = new Float32Array(nx * ny * k);
  const bestD = new Float64Array(k), bestI = new Int32Array(k);
  for (let j = 0; j < ny; j++) {
    const lat = n - j * res;
    const kx = 111.32 * Math.cos(lat * RAD);
    for (let i = 0; i < nx; i++) {
      const lon = w + i * res;
      bestD.fill(Infinity);
      bestI.fill(-1);
      const bx = Math.floor(lon / B), by = Math.floor(lat / B);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const c of buckets.get(key(bx + dx, by + dy)) ?? []) {
            const ddx = (centers[2 * c] - lon) * kx, ddy = (centers[2 * c + 1] - lat) * KM_PER_DEG_LAT;
            const d = ddx * ddx + ddy * ddy;
            if (d > maxKm * maxKm || d >= bestD[k - 1]) continue;
            let m = k - 1;
            while (m > 0 && bestD[m - 1] > d) {
              bestD[m] = bestD[m - 1];
              bestI[m] = bestI[m - 1];
              m--;
            }
            bestD[m] = d;
            bestI[m] = c;
          }
      const p = (j * nx + i) * k;
      let sum = 0;
      for (let m = 0; m < k; m++) {
        if (bestI[m] < 0) continue;
        const wt = 1 / (bestD[m] + 9);
        idx[p + m] = bestI[m];
        wts[p + m] = wt;
        sum += wt;
      }
      if (sum) for (let m = 0; m < k; m++) wts[p + m] /= sum;
    }
  }
  return { nx, ny, w, n, res, k, idx, wts };
}

export const SURFACE_LEVELS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

const alphaAt = (v: number) => {
  if (v <= RISK_ALPHA[0][0]) return RISK_ALPHA[0][1];
  for (let i = 1; i < RISK_ALPHA.length; i++) {
    const [v1, a1] = RISK_ALPHA[i];
    const [v0, a0] = RISK_ALPHA[i - 1];
    if (v <= v1) return a0 + ((a1 - a0) * (v - v0)) / (v1 - v0);
  }
  return RISK_ALPHA[RISK_ALPHA.length - 1][1];
};

/**
 * Stacked contour bands for one frame. Each band's alpha is chosen so that the composite alpha of
 * all bands up to level v equals the cell fill alpha at v — the surface matches the cell colours.
 */
export function surfaceFeatures(prep: SurfacePrep, values: ArrayLike<number>, stops: [number, string][], levels = SURFACE_LEVELS): Feature<MultiPolygon, { v: number; fill: string }>[] {
  const { nx, ny, k, idx, wts, w, n, res } = prep;
  const grid = new Array<number>(nx * ny);
  for (let p = 0; p < nx * ny; p++) {
    let acc = 0, wsum = 0;
    for (let m = 0; m < k; m++) {
      const c = idx[p * k + m];
      if (c < 0) continue;
      const v = values[c];
      if (!Number.isFinite(v) || v < 0) continue;
      acc += v * wts[p * k + m];
      wsum += wts[p * k + m];
    }
    grid[p] = wsum > 0 ? acc / wsum : -1;
  }
  const out: Feature<MultiPolygon, { v: number; fill: string }>[] = [];
  let prevTotal = 0;
  for (const shape of contours().size([nx, ny]).thresholds(levels)(grid)) {
    const v = shape.value;
    const total = alphaAt(v);
    const a = Math.max(0, Math.min(1, 1 - (1 - total) / (1 - prevTotal)));
    prevTotal = total;
    if (!shape.coordinates.length) continue;
    out.push({
      type: 'Feature',
      properties: { v, fill: rgba(rampRgb(stops, v), a) },
      geometry: {
        type: 'MultiPolygon',
        coordinates: shape.coordinates.map((poly) =>
          poly.map((ring) => ring.map(([x, y]) => [Math.round((w + (x - 0.5) * res) * 1e4) / 1e4, Math.round((n - (y - 0.5) * res) * 1e4) / 1e4])),
        ),
      },
    });
  }
  return out;
}

export interface CoarsePrep {
  features: Feature<Polygon, { id: number }>[];
  /** Super-hex index for each cell (−1 when outside). */
  member: Int32Array;
}

/** Bin cells into a flat-top hexagon lattice of `sizeKm` (centre-to-centre spacing). */
export function prepareCoarse(centers: Float32Array, sizeKm = 42): CoarsePrep {
  const count = centers.length / 2;
  let lat0 = 0;
  for (let i = 0; i < count; i++) lat0 += centers[2 * i + 1];
  lat0 = count ? lat0 / count : 37;
  const kx = 111.32 * Math.cos(lat0 * RAD);
  // Axial coordinates of a pointy-top hex lattice in km space.
  const size = sizeKm / Math.sqrt(3);
  const toKm = (lon: number, lat: number) => [lon * kx, lat * KM_PER_DEG_LAT];
  const keyOf = new Map<string, number>();
  const centersOut: [number, number][] = [];
  const member = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    const [x, y] = toKm(centers[2 * i], centers[2 * i + 1]);
    const q = ((Math.sqrt(3) / 3) * x - y / 3) / size;
    const r = ((2 / 3) * y) / size;
    // Cube rounding.
    let rx = Math.round(q), rz = Math.round(r);
    const ry = Math.round(-q - r);
    const dx = Math.abs(rx - q), dy = Math.abs(ry - (-q - r)), dz = Math.abs(rz - r);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (!(dy > dz)) rz = -rx - ry;
    const key = `${rx}:${rz}`;
    let id = keyOf.get(key);
    if (id == null) {
      id = centersOut.length;
      keyOf.set(key, id);
      const cx = size * Math.sqrt(3) * (rx + rz / 2), cy = size * 1.5 * rz;
      centersOut.push([cx, cy]);
    }
    member[i] = id;
  }
  const features = centersOut.map(([cx, cy], id): Feature<Polygon, { id: number }> => {
    const ring: [number, number][] = [];
    for (let c = 0; c < 6; c++) {
      const ang = (60 * c - 30) * RAD;
      ring.push([Math.round(((cx + size * Math.cos(ang)) / kx) * 1e4) / 1e4, Math.round(((cy + size * Math.sin(ang)) / KM_PER_DEG_LAT) * 1e4) / 1e4]);
    }
    ring.push(ring[0]);
    return { type: 'Feature', id, properties: { id }, geometry: { type: 'Polygon', coordinates: [ring] } };
  });
  return { features, member };
}

/** Maximum member score per super-hex (NaN when no member has a value). */
export function coarseValues(prep: CoarsePrep, values: ArrayLike<number>): Float32Array {
  const out = new Float32Array(prep.features.length).fill(NaN);
  for (let i = 0; i < prep.member.length; i++) {
    const v = values[i];
    const m = prep.member[i];
    if (m < 0 || !Number.isFinite(v)) continue;
    if (!(out[m] >= v)) out[m] = v;
  }
  return out;
}
