import type { Units } from '../types';
import { compass16 } from './geo';

export const cToF = (c: number) => (c * 9) / 5 + 32;
export const kmhToMph = (k: number) => k * 0.621371;
export const mmToIn = (mm: number) => mm / 25.4;
export const kmToMi = (km: number) => km * 0.621371;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const UNAVAILABLE = 'Unavailable';

export function formatTemp(c: number | null | undefined, units: Units): string {
  if (!isNum(c)) return UNAVAILABLE;
  return units === 'us' ? `${Math.round(cToF(c))}°F` : `${Math.round(c)}°C`;
}
export function formatTempShort(c: number | null | undefined, units: Units): string {
  if (!isNum(c)) return '–';
  return `${Math.round(units === 'us' ? cToF(c) : c)}°`;
}
export function formatSpeed(kmh: number | null | undefined, units: Units): string {
  if (!isNum(kmh)) return UNAVAILABLE;
  return units === 'us' ? `${Math.round(kmhToMph(kmh))} mph` : `${Math.round(kmh)} km/h`;
}
export function formatWind(kmh: number | null | undefined, dirDeg: number | null | undefined, units: Units): string {
  if (!isNum(kmh)) return UNAVAILABLE;
  if (kmh < 1.5) return 'Calm';
  return `${isNum(dirDeg) ? compass16(dirDeg) + ' ' : ''}${formatSpeed(kmh, units)}`;
}
export function formatPrecip(mm: number | null | undefined, units: Units): string {
  if (!isNum(mm)) return UNAVAILABLE;
  if (mm < 0.05) return 'None';
  return units === 'us' ? `${mmToIn(mm).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
}
export function formatDistance(km: number | null | undefined, units: Units): string {
  if (!isNum(km)) return UNAVAILABLE;
  const v = units === 'us' ? kmToMi(km) : km;
  const unit = units === 'us' ? 'mi' : 'km';
  return v < 10 ? `${v.toFixed(1)} ${unit}` : `${Math.round(v)} ${unit}`;
}
export function formatElevation(m: number | null | undefined, units: Units): string {
  if (!isNum(m)) return UNAVAILABLE;
  return units === 'us' ? `${Math.round(m * 3.28084).toLocaleString('en-US')} ft` : `${Math.round(m).toLocaleString('en-US')} m`;
}
export const formatPct = (v: number | null | undefined, digits = 0) => (isNum(v) ? `${v.toFixed(digits)}%` : UNAVAILABLE);
export const formatInt = (v: number | null | undefined) => (isNum(v) ? Math.round(v).toLocaleString('en-US') : UNAVAILABLE);
export const formatAcres = (v: number | null | undefined) =>
  isNum(v) ? `${v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1)} acres` : UNAVAILABLE;
export const formatFrp = (v: number | null | undefined) => (isNum(v) ? `${v < 10 ? v.toFixed(1) : Math.round(v)} MW` : UNAVAILABLE);
export const formatScore = (v: number | null | undefined) => (isNum(v) ? v.toFixed(2) : UNAVAILABLE);
export function formatPopulation(v: number | null | undefined): string | null {
  if (!isNum(v) || v <= 0) return null;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M people`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k people`;
  return `${v.toLocaleString('en-US')} people`;
}
export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export const SENSOR_LABELS: Record<string, string> = {
  VIIRS_SNPP_NRT: 'VIIRS · Suomi NPP',
  VIIRS_NOAA20_NRT: 'VIIRS · NOAA-20',
  VIIRS_NOAA21_NRT: 'VIIRS · NOAA-21',
  MODIS_NRT: 'MODIS · Aqua/Terra',
};
export const sensorLabel = (s: string) => SENSOR_LABELS[s] ?? s.replace(/_/g, ' ');
export function confidenceLabel(c: string): string {
  const v = c.toLowerCase();
  if (v === 'h' || v === 'high') return 'High';
  if (v === 'n' || v === 'nominal') return 'Nominal';
  if (v === 'l' || v === 'low') return 'Low';
  const n = Number(c);
  return Number.isFinite(n) ? `${n}%` : capitalize(c);
}
