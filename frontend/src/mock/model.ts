/**
 * SAMPLE risk model. An additive log-odds model, so per-feature contributions are exact
 * SHAP values (they sum to the raw margin, like XGBoost `pred_contribs=True`).
 * It only exists so the UI can be built and demoed before the real XGBoost model ships.
 */
import type { Driver } from '../types';

export interface ModelInputs {
  wind_speed_10m: number;
  wind_gust_10m: number;
  relative_humidity_2m: number;
  temperature_2m: number;
  precipitation_6h: number;
  dead_fuel_moisture: number;
  days_since_rain: number;
  vegetation_density: number;
  fuel_type: string;
  slope: number;
  hotspot_history: number;
  active_hotspots_nearby: number;
}

interface NumericFeature {
  key: Exclude<keyof ModelInputs, 'fuel_type'>;
  label: string;
  unit: string;
  weight: number;
  center: number;
  transform?: (v: number) => number;
}

export const NUMERIC_FEATURES: NumericFeature[] = [
  { key: 'wind_speed_10m', label: 'Wind speed', unit: 'km/h', weight: 0.05, center: 14 },
  { key: 'wind_gust_10m', label: 'Wind gusts', unit: 'km/h', weight: 0.012, center: 24 },
  { key: 'relative_humidity_2m', label: 'Relative humidity', unit: '%', weight: -0.045, center: 30 },
  { key: 'temperature_2m', label: 'Air temperature', unit: '°C', weight: 0.035, center: 22 },
  { key: 'precipitation_6h', label: 'Recent rain (6 h)', unit: 'mm', weight: -0.9, center: 0, transform: (v) => Math.min(v, 4) },
  { key: 'dead_fuel_moisture', label: 'Dead fuel moisture', unit: '%', weight: -0.12, center: 9 },
  { key: 'days_since_rain', label: 'Days since rain', unit: 'days', weight: 0.006, center: 60 },
  { key: 'vegetation_density', label: 'Vegetation density', unit: 'index', weight: 2.1, center: 0.45 },
  { key: 'slope', label: 'Terrain slope', unit: '°', weight: 0.055, center: 6 },
  { key: 'hotspot_history', label: 'Past hotspot activity', unit: 'detections 2024–25', weight: 0.28, center: 1.2, transform: Math.log1p },
  { key: 'active_hotspots_nearby', label: 'Active hotspots nearby', unit: 'detections, 48 h', weight: 0.42, center: 0, transform: Math.log1p },
];

export const FUEL_EFFECT: Record<string, number> = {
  shrub: 0.6,
  grass: 0.45,
  forest: 0.35,
  agriculture: -0.9,
  urban: -1.45,
  desert: -1.75,
};
export const BIAS = -3.05;
export const MODEL_VERSION = 'demo-v0 (sample)';

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function rawMargin(x: ModelInputs): number {
  let m = BIAS + (FUEL_EFFECT[x.fuel_type] ?? 0);
  for (const f of NUMERIC_FEATURES) {
    const v = f.transform ? f.transform(x[f.key]) : x[f.key];
    m += f.weight * (v - f.center);
  }
  return m;
}
export const score = (x: ModelInputs) => sigmoid(rawMargin(x));

export function contributions(x: ModelInputs): { base: number; raw: number; score: number; drivers: Driver[] } {
  const drivers: Driver[] = NUMERIC_FEATURES.map((f) => {
    const v = f.transform ? f.transform(x[f.key]) : x[f.key];
    const c = f.weight * (v - f.center);
    return {
      feature: f.key,
      label: f.label,
      value: Math.round(x[f.key] * 100) / 100,
      unit: f.unit,
      contribution_raw: Math.round(c * 1000) / 1000,
      direction: c >= 0 ? 'increase' : 'decrease',
    };
  });
  const fuel = FUEL_EFFECT[x.fuel_type] ?? 0;
  drivers.push({
    feature: 'fuel_type',
    label: 'Fuel type',
    value: x.fuel_type,
    contribution_raw: Math.round(fuel * 1000) / 1000,
    direction: fuel >= 0 ? 'increase' : 'decrease',
  });
  drivers.sort((a, b) => Math.abs(b.contribution_raw) - Math.abs(a.contribution_raw));
  const raw = rawMargin(x);
  return { base: BIAS, raw, score: sigmoid(raw), drivers };
}
