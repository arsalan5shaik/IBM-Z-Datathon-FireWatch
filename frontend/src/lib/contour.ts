import { contours } from 'd3-contour';
import type { MultiPolygon } from 'geojson';
import type { LngLat } from './geo';

/**
 * Smooth outline around a set of points: sum of Gaussian kernels on a local grid,
 * traced at a threshold with marching squares. An isolated point becomes a disc of
 * radius ≈ 1.18·σ; points closer than ~2σ merge. Used for the ILLUSTRATIVE hotspot
 * influence shapes and the sample perimeters — never an area calculation of burned land.
 */
export function outlineAround(
  points: LngLat[],
  { sigmaKm = 0.35, threshold = 0.5, maxCells = 160_000 }: { sigmaKm?: number; threshold?: number; maxCells?: number } = {},
): MultiPolygon | null {
  if (!points.length) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  const lat0 = (s + n) / 2;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.57;
  const pad = sigmaKm * 3.2;
  w -= pad / kx;
  e += pad / kx;
  s -= pad / ky;
  n += pad / ky;
  const widthKm = (e - w) * kx, heightKm = (n - s) * ky;
  let res = sigmaKm / 3;
  while ((widthKm / res) * (heightKm / res) > maxCells) res *= 1.25;
  const nx = Math.ceil(widthKm / res) + 1, ny = Math.ceil(heightKm / res) + 1;
  const values = new Float64Array(nx * ny);
  const r = Math.ceil((sigmaKm * 3) / res);
  const inv = (res * res) / (2 * sigmaKm * sigmaKm);
  for (const [x, y] of points) {
    const px = ((x - w) * kx) / res, py = ((n - y) * ky) / res;
    const gx0 = Math.max(0, Math.floor(px - r)), gx1 = Math.min(nx - 1, Math.ceil(px + r));
    const gy0 = Math.max(0, Math.floor(py - r)), gy1 = Math.min(ny - 1, Math.ceil(py + r));
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++) {
        const d2 = (gx - px) ** 2 + (gy - py) ** 2;
        values[gy * nx + gx] += Math.exp(-d2 * inv);
      }
  }
  const [shape] = contours().size([nx, ny]).thresholds([threshold])(Array.from(values));
  if (!shape || !shape.coordinates.length) return null;
  const toLngLat = ([gx, gy]: number[]) => [
    Math.round((w + ((gx - 0.5) * res) / kx) * 1e5) / 1e5,
    Math.round((n - ((gy - 0.5) * res) / ky) * 1e5) / 1e5,
  ];
  return {
    type: 'MultiPolygon',
    coordinates: shape.coordinates.map((poly) => poly.map((ring) => ring.map(toLngLat))),
  };
}
