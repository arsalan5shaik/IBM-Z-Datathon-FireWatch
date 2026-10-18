/**
 * Regular-grid wind field for the animated flow layer. Forecast samples (speed + meteorological FROM
 * direction) are converted to flow vectors (u east, v north, km/h) and spread onto a lat/lon lattice
 * with inverse-distance weighting. Cells farther than `maxKm` from every sample stay empty (NaN), so
 * streaks never animate where there is no forecast.
 */
const RAD = Math.PI / 180;

export interface WindField {
  w: number;
  n: number;
  res: number;
  nx: number;
  ny: number;
  /** Flow toward east / north in km/h; NaN = no data. Row-major from the north-west corner. */
  u: Float32Array;
  v: Float32Array;
}

export const FIELD_BBOX: [number, number, number, number] = [-127, 31.5, -113, 43];

/** Flow vector (toward) from speed and meteorological FROM direction. */
export function flowVector(speed: number, fromDeg: number): [number, number] {
  return [-speed * Math.sin(fromDeg * RAD), -speed * Math.cos(fromDeg * RAD)];
}

export function buildWindField(
  points: ArrayLike<readonly [number, number]>,
  speed: ArrayLike<number>,
  fromDeg: ArrayLike<number>,
  bbox: [number, number, number, number] = FIELD_BBOX,
  res = 0.1,
  maxKm = 40,
): WindField {
  const [w, s, e, n] = bbox;
  const nx = Math.round((e - w) / res) + 1;
  const ny = Math.round((n - s) / res) + 1;
  const B = 0.5;
  const buckets = new Map<number, number[]>();
  const key = (bx: number, by: number) => bx * 4096 + by;
  const pu = new Float32Array(points.length);
  const pv = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const sp = speed[i], dir = fromDeg[i];
    if (!Number.isFinite(sp) || !Number.isFinite(dir)) {
      pu[i] = pv[i] = NaN;
      continue;
    }
    [pu[i], pv[i]] = flowVector(sp, dir);
    const k = key(Math.floor(points[i][0] / B), Math.floor(points[i][1] / B));
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  }
  const u = new Float32Array(nx * ny).fill(NaN);
  const v = new Float32Array(nx * ny).fill(NaN);
  const max2 = maxKm * maxKm;
  for (let j = 0; j < ny; j++) {
    const lat = n - j * res;
    const kx = 111.32 * Math.cos(lat * RAD);
    for (let i = 0; i < nx; i++) {
      const lon = w + i * res;
      const bx = Math.floor(lon / B), by = Math.floor(lat / B);
      let su = 0, sv = 0, sw = 0, nearest = Infinity;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const list = buckets.get(key(bx + dx, by + dy));
          if (!list) continue;
          for (const p of list) {
            const ddx = (points[p][0] - lon) * kx, ddy = (points[p][1] - lat) * 110.57;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 < nearest) nearest = d2;
            if (d2 > max2 * 2.25) continue;
            const wt = 1 / (d2 + 16);
            su += pu[p] * wt;
            sv += pv[p] * wt;
            sw += wt;
          }
        }
      if (!sw || nearest > max2) continue;
      u[j * nx + i] = su / sw;
      v[j * nx + i] = sv / sw;
    }
  }
  return { w, n, res, nx, ny, u, v };
}

/** Bilinear sample at (lon, lat) into `out` ([u, v]); returns false outside the data. */
export function sampleField(f: WindField, lon: number, lat: number, out: [number, number]): boolean {
  const x = (lon - f.w) / f.res, y = (f.n - lat) / f.res;
  const i = Math.floor(x), j = Math.floor(y);
  if (i < 0 || j < 0 || i >= f.nx - 1 || j >= f.ny - 1) return false;
  const tx = x - i, ty = y - j;
  const a = j * f.nx + i, b = a + 1, c = a + f.nx, d = c + 1;
  const ua = f.u[a], ub = f.u[b], uc = f.u[c], ud = f.u[d];
  if (Number.isNaN(ua) || Number.isNaN(ub) || Number.isNaN(uc) || Number.isNaN(ud)) {
    // Edge of the data: fall back to the nearest valid corner so streaks reach the coast.
    const corners = [a, b, c, d];
    const pick = corners[(tx > 0.5 ? 1 : 0) + (ty > 0.5 ? 2 : 0)];
    if (Number.isNaN(f.u[pick])) return false;
    out[0] = f.u[pick];
    out[1] = f.v[pick];
    return true;
  }
  const top = ua + (ub - ua) * tx, bot = uc + (ud - uc) * tx;
  out[0] = top + (bot - top) * ty;
  const vt = f.v[a] + (f.v[b] - f.v[a]) * tx, vb = f.v[c] + (f.v[d] - f.v[c]) * tx;
  out[1] = vt + (vb - vt) * ty;
  return true;
}
