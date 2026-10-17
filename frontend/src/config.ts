/**
 * Runtime configuration.
 *
 * Data source selection:
 *   - VITE_API_BASE_URL (build time) or ?api=<url> (run time) → use the FireWatch backend (/api/v1 contract).
 *   - Neither set, or ?demo=1 → offline SAMPLE DATA generated in the browser (clearly labelled in the UI).
 * Configured API observations and model predictions remain explicitly unavailable on failure;
 * successful previous data can be retained with stale labels.
 */
import type { RiskLevelKey } from './types';

function resolveApiBase(): string | null {
  const qs = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
  if (qs.get('demo') === '1') return null;
  const value = qs.get('api') ?? import.meta.env.VITE_API_BASE_URL ?? '';
  return value ? value.replace(/\/+$/, '') : null;
}

export const API_BASE = resolveApiBase();
export const DATA_URL = (path: string) => `${import.meta.env.BASE_URL}data/${path}`;

export const TIMEZONE = 'America/Los_Angeles';

/** California extent used for the initial view and the "home" button. */
export const CA_BOUNDS: [[number, number], [number, number]] = [
  [-124.48, 32.53],
  [-114.13, 42.01],
];
/** Pan limit: California plus a margin so the coast and borders stay in view. */
export const MAX_BOUNDS: [[number, number], [number, number]] = [
  [-133, 28.5],
  [-105.5, 46],
];

export const VIEW_3D_PITCH = 25;
export const VIEW_TRANSITION_MS = 800;
export const TERRAIN_EXAGGERATION = 1;

export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_ATTRIBUTION =
  '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles (Mapzen/AWS)</a>';
export const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Illustrative SAMPLE categories only; real model thresholds are not finalized. */
export const RISK_LEVELS: { key: RiskLevelKey; label: string; min: number; color: string }[] = [
  { key: 'low', label: 'Low', min: 0, color: '#CBD5E1' },
  { key: 'elevated', label: 'Elevated', min: 0.2, color: '#FFAA33' },
  { key: 'high', label: 'High', min: 0.4, color: '#FF6A13' },
  { key: 'very_high', label: 'Very High', min: 0.6, color: '#E3262F' },
  { key: 'extreme', label: 'Extreme', min: 0.8, color: '#6A1B9A' },
];

/** Continuous ramp used by the map fill: orange → red → purple (highest). */
export const RISK_RAMP: [number, string][] = [
  [0.2, '#FFB547'],
  [0.4, '#FF7A1A'],
  [0.6, '#E8262B'],
  [0.8, '#B0124F'],
  [1.0, '#5B1A8C'],
];

export const HOTSPOT_AGE_COLORS: { maxHours: number; color: string; label: string }[] = [
  { maxHours: 3, color: '#FFE14D', label: '< 3 h' },
  { maxHours: 12, color: '#FFC23D', label: '3–12 h' },
  { maxHours: 24, color: '#E59A32', label: '12–24 h' },
  { maxHours: Infinity, color: '#A7795A', label: '> 24 h' },
];

export const WIND_RAMP: [number, string][] = [
  [0, '#7FB2F5'],
  [15, '#4B8EF0'],
  [30, '#2F6BFF'],
  [50, '#1E3FB8'],
  [70, '#14206B'],
];

export const FUEL_CLASSES: Record<string, { label: string; color: string }> = {
  forest: { label: 'Forest / timber', color: '#3F7D4E' },
  shrub: { label: 'Shrub / chaparral', color: '#9A8B3C' },
  grass: { label: 'Grass / oak savanna', color: '#C9B95C' },
  agriculture: { label: 'Agriculture', color: '#8FB573' },
  urban: { label: 'Urban / developed', color: '#9AA1AA' },
  desert: { label: 'Desert / sparse', color: '#D9C7A3' },
};

export const LOOKBACK_OPTIONS = [6, 12, 24, 48] as const;

export const POLL_STATUS_MS = 60_000;
export const POLL_FIRES_MS = 5 * 60_000;
/** A snapshot older than this is shown as stale. */
export const STALE_AFTER_MS = 6 * 3600_000;

export const CHAT_MAX_CHARS = 600;
export const CHAT_MAX_TURNS_SENT = 10;

/** Official sources the UI and assistant point to for safety decisions. */
export const OFFICIAL_LINKS = [
  { label: 'CAL FIRE incidents', href: 'https://www.fire.ca.gov/incidents' },
  { label: 'Evacuation zones (Genasys Protect)', href: 'https://protect.genasys.com' },
  { label: 'Ready for Wildfire', href: 'https://www.readyforwildfire.org' },
  { label: 'NWS fire weather', href: 'https://www.weather.gov/fire/' },
];

/** Cities used for the optional weather layer and quick suggestions. */
export const WEATHER_CITIES: { name: string; lon: number; lat: number; rank: number }[] = [
  { name: 'Los Angeles', lon: -118.2437, lat: 34.0522, rank: 1 },
  { name: 'San Diego', lon: -117.1611, lat: 32.7157, rank: 1 },
  { name: 'San Jose', lon: -121.8863, lat: 37.3382, rank: 1 },
  { name: 'San Francisco', lon: -122.4194, lat: 37.7749, rank: 1 },
  { name: 'Fresno', lon: -119.7871, lat: 36.7378, rank: 1 },
  { name: 'Sacramento', lon: -121.4944, lat: 38.5816, rank: 1 },
  { name: 'Bakersfield', lon: -119.0187, lat: 35.3733, rank: 1 },
  { name: 'Redding', lon: -122.3917, lat: 40.5865, rank: 1 },
  { name: 'Eureka', lon: -124.1637, lat: 40.8021, rank: 1 },
  { name: 'Palm Springs', lon: -116.5453, lat: 33.8303, rank: 1 },
  { name: 'Stockton', lon: -121.2908, lat: 37.9577, rank: 2 },
  { name: 'Riverside', lon: -117.3961, lat: 33.9533, rank: 2 },
  { name: 'Santa Rosa', lon: -122.7141, lat: 38.4404, rank: 2 },
  { name: 'Modesto', lon: -120.9969, lat: 37.6391, rank: 2 },
  { name: 'Santa Barbara', lon: -119.6982, lat: 34.4208, rank: 2 },
  { name: 'San Luis Obispo', lon: -120.6596, lat: 35.2828, rank: 2 },
  { name: 'Chico', lon: -121.8375, lat: 39.7285, rank: 2 },
  { name: 'Barstow', lon: -117.0228, lat: 34.8958, rank: 2 },
  { name: 'Bishop', lon: -118.3951, lat: 37.3635, rank: 2 },
  { name: 'South Lake Tahoe', lon: -119.9772, lat: 38.9399, rank: 2 },
  { name: 'Monterey', lon: -121.8947, lat: 36.6002, rank: 2 },
  { name: 'Ukiah', lon: -123.2078, lat: 39.1502, rank: 3 },
  { name: 'Yreka', lon: -122.6345, lat: 41.7354, rank: 3 },
  { name: 'Alturas', lon: -120.5427, lat: 41.4871, rank: 3 },
  { name: 'Susanville', lon: -120.6530, lat: 40.4163, rank: 3 },
  { name: 'Mammoth Lakes', lon: -118.9721, lat: 37.6485, rank: 3 },
  { name: 'Visalia', lon: -119.2921, lat: 36.3302, rank: 3 },
  { name: 'Merced', lon: -120.4830, lat: 37.3022, rank: 3 },
  { name: 'Lancaster', lon: -118.1542, lat: 34.6868, rank: 3 },
  { name: 'Needles', lon: -114.6141, lat: 34.8481, rank: 3 },
  { name: 'El Centro', lon: -115.5631, lat: 32.792, rank: 3 },
  { name: 'Oxnard', lon: -119.1771, lat: 34.1975, rank: 3 },
  { name: 'Salinas', lon: -121.6555, lat: 36.6777, rank: 3 },
  { name: 'Crescent City', lon: -124.2026, lat: 41.756, rank: 3 },
  { name: 'Paso Robles', lon: -120.691, lat: 35.6266, rank: 3 },
];

export const QUICK_PLACES = ['place-ca-sacramento', 'place-ca-los-angeles', 'place-ca-fresno', 'place-ca-stockton', 'county-ca-butte'];


/** Continuous display endpoints, not category thresholds. Backend scores are normalized 0–1. */
export const MODEL_SCORE_COLORS = ['#fff5e6', '#7a1c8c'] as const;
