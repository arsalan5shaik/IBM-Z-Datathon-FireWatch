import type { WeatherGrid } from '../types';
import { weatherFrame } from '../state/lookups';

/** Meteorological direction is FROM north; the existing arrow icon points TOWARD flow. */
export const windToward = (from: number) => (from + 180) % 360;

export function windFeatures(grid: WeatherGrid, t: number, levels: Uint8Array) {
  const frame = weatherFrame(grid, t);
  if (frame < 0) return [];
  return grid.points.flatMap((point, i) => {
    const offset = frame * grid.points.length + i;
    const speed = grid.wind_speed_kmh[offset], direction = grid.wind_direction_deg[offset];
    if (!Number.isFinite(speed) || !Number.isFinite(direction)) return [];
    return [{ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: point },
      properties: { s: speed, d: windToward(direction), lvl: levels[i], i } }];
  });
}
