/**
 * SAMPLE weather generator. Produces plausible mid-autumn California fire weather:
 * marine-layer coast, hot dry interior, diurnal cycles, a heat ridge, a NorCal offshore
 * (Diablo-style) wind event, a SoCal Santa Ana event, and a cooling trough with light
 * rain in the far north late in the week. Purely synthetic — replaced by Open-Meteo
 * forecast data from the backend.
 */
import { DAY_MS, HOUR_MS } from '../lib/time';
import { mulberry32, valueNoise } from './random';

export interface Env {
  lon: number;
  lat: number;
  elev: number;
  coastKm: number;
  fuel: string;
  ocean: boolean;
}

export interface Scenario {
  start: number;
  seed: number;
  ncal: { peak: number; sigmaH: number; strength: number };
  scal: { peak: number; sigmaH: number; strength: number };
  heatPeakDay: number;
  heatAmp: number;
  troughDay: number;
  rain: number;
}

export function makeScenario(start: number): Scenario {
  const seed = Math.floor(start / DAY_MS);
  const rng = mulberry32(seed * 7919);
  return {
    start,
    seed,
    ncal: { peak: start + (2.2 + rng() * 0.6) * DAY_MS, sigmaH: 13 + rng() * 6, strength: 0.85 + rng() * 0.15 },
    scal: { peak: start + (3.3 + rng() * 0.7) * DAY_MS, sigmaH: 16 + rng() * 8, strength: 0.9 + rng() * 0.1 },
    heatPeakDay: 2.6 + rng() * 0.8,
    heatAmp: 3 + rng() * 2,
    troughDay: 5.4 + rng() * 0.5,
    rain: 0.8 + rng() * 1.2,
  };
}

const gauss = (x: number, mu: number, sigma: number) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const TAU = Math.PI * 2;

function solarHour(t: number, lon: number): number {
  const utcH = (t / HOUR_MS) % 24;
  return (((utcH + lon / 15) % 24) + 24) % 24;
}

/** 0..1 exposure to the NorCal offshore event. */
function norcalRegion(e: Env): number {
  const lat = gauss(e.lat, 39.0, 1.0);
  const lon = e.lon < -120.4 ? 1 : gauss(e.lon, -120.4, 0.35);
  let terrain = 1;
  if (e.ocean) terrain = e.coastKm < 40 ? 0.35 : 0.12;
  else if (e.elev < 80) terrain = 0.55;
  else if (e.elev > 2000) terrain = 0.6;
  return lat * lon * terrain;
}
/** 0..1 exposure to the SoCal Santa Ana event. */
function socalRegion(e: Env): number {
  const lat = gauss(e.lat, 34.0, 0.65);
  const lon = e.lon > -119.7 && e.lon < -116.2 ? 1 : gauss(e.lon, e.lon <= -119.7 ? -119.7 : -116.2, 0.3);
  let terrain = 1;
  if (e.ocean) terrain = e.coastKm < 40 ? 0.4 : 0.12;
  else if (e.fuel === 'desert') terrain = 0.35;
  else if (e.elev < 150) terrain = 0.75;
  else if (e.elev > 2200) terrain = 0.6;
  return lat * lon * terrain;
}

export interface WeatherSample {
  temperature_c: number;
  relative_humidity_pct: number;
  wind_speed_kmh: number;
  wind_direction_deg: number;
  wind_gust_kmh: number;
  precipitation_mm: number;
  offshore: number;
}

export function rainRate(e: Env, t: number, sc: Scenario): number {
  const dayF = (t - sc.start) / DAY_MS;
  if (e.lat < 38.6) return 0;
  const front = gauss(dayF, sc.troughDay + (41.5 - e.lat) * 0.18, 0.45);
  if (front < 0.05) return 0;
  const north = clamp((e.lat - 38.6) / 2.2, 0, 1);
  const coastal = e.ocean ? 0.8 : Math.exp(-e.coastKm / 140);
  const oro = !e.ocean && e.elev > 800 ? 1.35 : 1;
  const cells = valueNoise(e.lon * 3 + dayF * 2.5, e.lat * 3, sc.seed + 17);
  const r = sc.rain * front * north * coastal * oro * (0.25 + cells);
  return r < 0.05 ? 0 : r;
}

export function weatherAt(e: Env, t: number, sc: Scenario): WeatherSample {
  const dayF = (t - sc.start) / DAY_MS;
  const hs = solarHour(t, e.lon);
  const diurnal = Math.cos((TAU * (hs - 15)) / 24); // +1 mid-afternoon, -1 pre-dawn
  const nightBoost = 0.72 + 0.28 * Math.cos((TAU * (hs - 5)) / 24);

  const ncal = sc.ncal.strength * gauss(t, sc.ncal.peak, sc.ncal.sigmaH * HOUR_MS) * norcalRegion(e);
  const scal = sc.scal.strength * gauss(t, sc.scal.peak, sc.scal.sigmaH * HOUR_MS) * socalRegion(e);
  const offshore = Math.max(ncal, scal) * nightBoost;
  const heat = gauss(dayF, sc.heatPeakDay, 1.3) * sc.heatAmp;
  const trough = clamp((dayF - (sc.troughDay - 0.6)) / 1.2, 0, 1) * clamp((e.lat - 36) / 3, 0.2, 1);
  const precip = rainRate(e, t, sc);
  const n1 = valueNoise(e.lon * 2.2, e.lat * 2.2, sc.seed + 3);
  const nt = valueNoise(e.lon * 1.5 + dayF * 1.7, e.lat * 1.5, sc.seed + 9);

  // Temperature
  let temp: number;
  let tMean: number;
  if (e.ocean) {
    tMean = 17.5 - 0.45 * (e.lat - 36);
    temp = tMean + 0.8 * diurnal + 0.5 * heat * 0.3;
  } else {
    const inland = 1 - Math.exp(-e.coastKm / 30);
    tMean = 22.5 - 0.0063 * e.elev - 0.55 * (e.lat - 36) - 7 * Math.exp(-e.coastKm / 18) + (e.fuel === 'desert' ? 3 : 0);
    tMean += heat * (0.5 + 0.5 * inland) + offshore * 5 * (1 - inland * 0.5) - trough * 4 + (n1 - 0.5) * 2;
    const amp = e.fuel === 'desert' ? 10 : 2.5 + 7 * inland;
    temp = tMean + amp * diurnal - (precip > 0 ? 2.5 : 0);
  }

  // Relative humidity
  let rh: number;
  if (e.ocean) rh = 82 - 6 * diurnal - offshore * 35;
  else {
    const rhMean = 26 + 52 * Math.exp(-e.coastKm / 22) - (e.fuel === 'desert' ? 12 : 0) + (e.elev > 1800 ? 5 : 0);
    rh = rhMean * Math.exp(-0.05 * (temp - tMean)) * (1 - 0.78 * offshore) - heat * 2.2 + trough * 14;
    if (precip > 0) rh += 30 * clamp(precip, 0, 1.2);
  }
  rh = clamp(rh + (nt - 0.5) * 6, 3, 100);

  // Wind as vectors (u east, v north), meteorological "from" directions.
  const vec = (fromDeg: number, speed: number): [number, number] => {
    const r = (fromDeg * Math.PI) / 180;
    return [-speed * Math.sin(r), -speed * Math.cos(r)];
  };
  const dirJitter = (n1 - 0.5) * 36 + (nt - 0.5) * 16;
  let bgSpeed = e.ocean ? 22 + 6 * n1 : (4 + 19 * Math.exp(-e.coastKm / 32)) * (0.5 + 0.5 * Math.max(0, diurnal));
  let bgDir = 305 + dirJitter;
  if (trough > 0.2 && e.lat > 38.5) {
    bgSpeed *= 1 + trough * 0.7;
    bgDir = 215 + dirJitter * 0.5;
  }
  const bg = vec(bgDir, bgSpeed * (1 - 0.85 * offshore));
  const valley = e.ocean
    ? ([0, 0] as [number, number])
    : diurnal > 0
      ? vec(235 + dirJitter, (3 + 7 * diurnal) * (1 - offshore))
      : vec(55 + dirJitter, (2 + 4 * -diurnal) * (1 - offshore));
  const evDir = (ncal >= scal ? 35 : 55) + dirJitter * 0.6;
  const ev = vec(evDir, 68 * offshore * (0.75 + 0.5 * n1));
  const u = bg[0] + valley[0] + ev[0];
  const v = bg[1] + valley[1] + ev[1];
  const speed = Math.hypot(u, v) * (0.85 + 0.3 * nt);
  const dir = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;
  const gust = speed * (1.3 + 0.4 * offshore) + 3;

  return {
    temperature_c: temp,
    relative_humidity_pct: rh,
    wind_speed_kmh: speed,
    wind_direction_deg: dir,
    wind_gust_kmh: gust,
    precipitation_mm: precip,
    offshore,
  };
}

/** Days since meaningful rain at time t (baseline by latitude, reset by forecast rain). */
export function daysSinceRain(e: Env, t: number, sc: Scenario): number {
  const dayF = (t - sc.start) / DAY_MS;
  const base = clamp(16 + (40.8 - e.lat) * 38, 8, 210);
  if (e.lat >= 38.6) {
    const rainDay = sc.troughDay + (41.5 - e.lat) * 0.18;
    if (dayF > rainDay + 0.3 && rainRate(e, sc.start + rainDay * DAY_MS, sc) > 0.2) return Math.max(0, dayF - rainDay);
  }
  return base + dayF;
}

/** Simple 10-hour dead fuel moisture proxy (%). */
export function fuelMoisture(tempC: number, rh: number, precip6h: number): number {
  return clamp(2.4 + 0.155 * rh - 0.045 * (tempC - 20) + 7 * clamp(precip6h / 3, 0, 1), 2, 35);
}
