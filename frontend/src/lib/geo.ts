import type { Geometry, MultiPolygon, Polygon, Position } from 'geojson';

export type LngLat = [number, number];
export type BBox = [number, number, number, number];

const RAD = Math.PI / 180;

export function distanceKm(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees clockwise from north. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
  const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass16 = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const COMPASS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass8 = (deg: number) => COMPASS8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

function inRing(x: number, y: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(x: number, y: number, rings: Position[][]): boolean {
  if (!rings.length || !inRing(x, y, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (inRing(x, y, rings[k])) return false;
  return true;
}
export function pointInGeometry(p: LngLat, g: Geometry | null | undefined): boolean {
  if (!g) return false;
  if (g.type === 'Polygon') return inPolygon(p[0], p[1], g.coordinates);
  if (g.type === 'MultiPolygon') return g.coordinates.some((poly) => inPolygon(p[0], p[1], poly));
  return false;
}

export function bboxOfGeometry(g: Polygon | MultiPolygon): BBox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys)
    for (const [x, y] of poly[0]) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  return [w, s, e, n];
}
export const bboxContains = (b: BBox, p: LngLat) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
export const bboxIntersects = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export function bboxOfPoints(points: LngLat[]): BBox {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) {
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return [w, s, e, n];
}
/** Expand a bbox by `km` on every side. */
export function padBbox(b: BBox, km: number): BBox {
  const dLat = km / 110.57;
  const dLon = km / (111.32 * Math.cos(((b[1] + b[3]) / 2) * RAD));
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

/** Planar-on-sphere ring area in km² (good to <1% at fire/city scales). */
function ringAreaKm2(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * RAD * (2 + Math.sin(ring[j][1] * RAD) + Math.sin(ring[i][1] * RAD));
  }
  return Math.abs((sum * 6371.0088 * 6371.0088) / 2);
}
export function areaKm2(g: Polygon | MultiPolygon): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let total = 0;
  for (const poly of polys) {
    total += ringAreaKm2(poly[0]);
    for (let k = 1; k < poly.length; k++) total -= ringAreaKm2(poly[k]);
  }
  return total;
}
export const KM2_TO_ACRES = 247.105;

export function centroidOfGeometry(g: Polygon | MultiPolygon): LngLat {
  const b = bboxOfGeometry(g);
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

/** Parse "37.95, -121.29" or "-121.29 37.95" style coordinate input. */
export function parseCoordinates(q: string): LngLat | null {
  const m = q.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && a > 0 && b < 0) return [b, a]; // lat, lon
  if (Math.abs(b) <= 90 && Math.abs(a) <= 180 && b > 0 && a < 0) return [a, b]; // lon, lat
  return null;
}
