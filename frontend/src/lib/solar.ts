/**
 * Sun position (NOAA low-precision formulas, ±0.5°) for the day/night overlay, timeline night bands
 * and the 3D sky. Times are epoch milliseconds (UTC).
 */
import { contours } from 'd3-contour';
import type { Feature, MultiPolygon } from 'geojson';

const RAD = Math.PI / 180;
const J2000 = Date.UTC(2000, 0, 1, 12);

export function sunPosition(t: number): { declination: number; rightAscension: number; gmstDeg: number } {
  const d = (t - J2000) / 86_400_000;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const rightAscension = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD;
  const declination = Math.asin(Math.sin(e) * Math.sin(L)) / RAD;
  const gmstHours = (18.697374558 + 24.06570982441908 * d) % 24;
  return { declination, rightAscension, gmstDeg: gmstHours * 15 };
}

/** Sun elevation above the horizon in degrees at a point and time. */
export function sunElevation(lng: number, lat: number, t: number): number {
  const { declination, rightAscension, gmstDeg } = sunPosition(t);
  const H = (gmstDeg + lng - rightAscension) * RAD;
  const phi = lat * RAD, dec = declination * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) / RAD;
}

/** Sunrise/sunset threshold (refraction + solar radius). */
export const HORIZON_DEG = -0.833;
export const isNight = (lng: number, lat: number, t: number) => sunElevation(lng, lat, t) < HORIZON_DEG;

/** "night" | "twilight" | "day" for sky styling. */
export function skyPhase(lng: number, lat: number, t: number): 'night' | 'twilight' | 'day' {
  const e = sunElevation(lng, lat, t);
  return e < -6 ? 'night' : e < 4 ? 'twilight' : 'day';
}

/**
 * Night polygons (sun below the horizon, below −6° and below −12°) over `bbox`, traced with
 * marching squares on a lattice, so the overlay stays correct near equinoxes and poles.
 * The three nested bands give the terminator a soft twilight edge.
 */
export function nightFeatures(t: number, bbox: [number, number, number, number] = [-136, 24, -100, 50], step = 0.25): Feature<MultiPolygon, { band: number }>[] {
  const [w, s, e, n] = bbox;
  const nx = Math.ceil((e - w) / step) + 1;
  const ny = Math.ceil((n - s) / step) + 1;
  const values = new Array<number>(nx * ny);
  const { declination, rightAscension, gmstDeg } = sunPosition(t);
  const dec = declination * RAD;
  const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  for (let j = 0; j < ny; j++) {
    const lat = n - j * step;
    const phi = lat * RAD;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    for (let i = 0; i < nx; i++) {
      const lng = w + i * step;
      const H = (gmstDeg + lng - rightAscension) * RAD;
      // Depression below the horizon (positive at night).
      values[j * nx + i] = -Math.asin(sp * sinDec + cp * cosDec * Math.cos(H)) / RAD;
    }
  }
  const bands = [-HORIZON_DEG, 6, 12];
  return contours()
    .size([nx, ny])
    .thresholds(bands)(values)
    .filter((c) => c.coordinates.length)
    .map((c, k) => ({
      type: 'Feature' as const,
      properties: { band: k },
      geometry: {
        type: 'MultiPolygon' as const,
        coordinates: c.coordinates.map((poly) => poly.map((ring) => ring.map(([x, y]) => [w + x * step, n - y * step]))),
      },
    }));
}

/** Fraction (0–1) of each hour [t, t+1h) that is night at a point, sampled every 10 minutes. */
export function nightFraction(lng: number, lat: number, hourStart: number): number {
  let night = 0;
  for (let k = 0; k < 6; k++) if (isNight(lng, lat, hourStart + k * 600_000 + 300_000)) night++;
  return night / 6;
}
