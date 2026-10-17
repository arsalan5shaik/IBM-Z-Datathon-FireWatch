/**
 * SAMPLE satellite detections, incidents and perimeters. Locations, names and numbers are
 * fictional and generated relative to "now" so the demo always looks current. The UI labels
 * all of it as sample data. Replaced by /api/v1/fires (NASA FIRMS) and an official perimeter feed.
 */
import type { Detection, Incident } from '../types';
import { outlineAround } from '../lib/contour';
import { KM2_TO_ACRES, areaKm2, type LngLat } from '../lib/geo';
import { HOUR_MS, toIso } from '../lib/time';
import { gaussian, hash2, mulberry32 } from './random';

interface SampleFire {
  id: string;
  name: string;
  origin: LngLat;
  ageH: number; // hours since ignition at "now"
  axisDeg: number; // direction the head of the fire advances toward
  growth: number; // km of head-fire run per hour^0.85
  widthRatio: number;
  intensity: number;
  containment: number | null;
  status: string;
}

const SAMPLE_FIRES: SampleFire[] = [
  { id: 'inc-granite-ridge', name: 'Granite Ridge Fire', origin: [-121.43, 39.86], ageH: 41, axisDeg: 222, growth: 0.36, widthRatio: 0.42, intensity: 1, containment: 10, status: 'Active' },
  { id: 'inc-bear-gulch', name: 'Bear Gulch Fire', origin: [-122.88, 40.92], ageH: 31, axisDeg: 64, growth: 0.24, widthRatio: 0.5, intensity: 0.75, containment: 35, status: 'Active' },
  { id: 'inc-mount-lowe', name: 'Mount Lowe Fire', origin: [-118.06, 34.28], ageH: 21, axisDeg: 238, growth: 0.27, widthRatio: 0.38, intensity: 0.85, containment: null, status: 'Active' },
  { id: 'inc-pine-flat', name: 'Pine Flat Fire', origin: [-119.29, 36.85], ageH: 27, axisDeg: 48, growth: 0.2, widthRatio: 0.55, intensity: 0.6, containment: 5, status: 'Active' },
  { id: 'inc-mill-creek', name: 'Mill Creek Fire', origin: [-123.03, 39.41], ageH: 15, axisDeg: 118, growth: 0.15, widthRatio: 0.5, intensity: 0.45, containment: null, status: 'Active' },
  { id: 'inc-laguna-rim', name: 'Laguna Rim Fire', origin: [-116.5, 32.86], ageH: 9.5, axisDeg: 248, growth: 0.32, widthRatio: 0.45, intensity: 0.7, containment: null, status: 'New' },
  { id: 'inc-cuesta-grade', name: 'Cuesta Grade Fire', origin: [-120.62, 35.35], ageH: 10, axisDeg: 152, growth: 0.12, widthRatio: 0.6, intensity: 0.35, containment: 60, status: 'Active' },
];

/** Isolated heat sources (agricultural burns, industrial flares) with no incident. */
const SCATTER_AREAS: { box: [number, number, number, number]; n: number }[] = [
  { box: [-122.1, 38.9, -121.5, 39.9], n: 9 }, // Sacramento Valley rice/orchard burns
  { box: [-120.6, 36.3, -119.6, 37.1], n: 8 }, // San Joaquin Valley
  { box: [-119.4, 35.2, -119.0, 35.6], n: 4 }, // Kern oil fields
  { box: [-115.7, 32.7, -115.4, 33.1], n: 3 }, // Imperial Valley
  { box: [-122.4, 37.9, -122.0, 38.1], n: 2 }, // refinery flares
];

// Overpass times (local solar hours) for the three VIIRS satellites.
const PASSES: { sensor: string; hour: number }[] = [
  { sensor: 'VIIRS_NOAA20_NRT', hour: 12.7 },
  { sensor: 'VIIRS_NOAA21_NRT', hour: 13.1 },
  { sensor: 'VIIRS_SNPP_NRT', hour: 13.5 },
  { sensor: 'VIIRS_NOAA20_NRT', hour: 0.9 },
  { sensor: 'VIIRS_NOAA21_NRT', hour: 1.3 },
  { sensor: 'VIIRS_SNPP_NRT', hour: 1.7 },
];

function overpasses(now: number, lookbackH: number, lon: number): { sensor: string; t: number; day: boolean }[] {
  const out: { sensor: string; t: number; day: boolean }[] = [];
  const offsetH = -lon / 15; // local solar → UTC
  const dayStart = Math.floor(now / (24 * HOUR_MS)) * 24 * HOUR_MS;
  for (let d = -3; d <= 0; d++)
    for (const p of PASSES) {
      const jitter = ((Math.abs(d * 37 + p.hour * 11) % 7) - 3) * 0.12; // orbit drift, ± ~20 min
      const t = dayStart + d * 24 * HOUR_MS + (p.hour + offsetH + jitter) * HOUR_MS;
      if (t <= now - 20 * 60_000 && t >= now - lookbackH * HOUR_MS) out.push({ sensor: p.sensor, t, day: p.hour > 6 && p.hour < 18 });
    }
  return out.sort((a, b) => a.t - b.t);
}

const KX = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);
const offsetPoint = ([lon, lat]: LngLat, eastKm: number, northKm: number): LngLat => [lon + eastKm / KX(lat), lat + northKm / 110.57];
const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace(/[-:T]/g, '');

export interface SampleFireData {
  detections: Detection[];
  incidents: Incident[];
  generatedAt: number;
}

/**
 * @param ref   time the fire ages are measured from (fixed for a session so fires keep growing)
 * @param now   detections are generated for overpasses up to this time
 */
export function generateSampleFires(ref: number, now: number, seed: number): SampleFireData {
  const detections: Detection[] = [];
  const incidents: Incident[] = [];

  SAMPLE_FIRES.forEach((fire, fireIndex) => {
    const ignition = ref - fire.ageH * HOUR_MS;
    const axis = (fire.axisDeg * Math.PI) / 180;
    const ax = Math.sin(axis), ay = Math.cos(axis); // unit vector east/north
    const fireDets: Detection[] = [];
    for (const pass of overpasses(now, 48, fire.origin[0])) {
      // Per fire+overpass RNG keeps earlier detections identical when new overpasses arrive.
      const rng = mulberry32(Math.floor(hash2(fireIndex, Math.round(pass.t / 60_000), seed) * 2 ** 32));
      const age = (pass.t - ignition) / HOUR_MS;
      if (age < 0.4) continue;
      const head = fire.growth * age ** 0.85 + 0.25;
      const half = head / 2;
      const width = head * fire.widthRatio + 0.3;
      const center = offsetPoint(fire.origin, ax * half * 0.85, ay * half * 0.85);
      const perimeter = Math.PI * (half + width / 2);
      const activity = fire.intensity * (pass.day ? 1 : 0.6) * (age < 3 ? 0.6 : 1);
      const count = Math.min(220, Math.max(2, Math.round((perimeter / 0.375) * 1.0 * activity)));
      for (let k = 0; k < count; k++) {
        const interior = rng() < 0.16;
        // Head-weighted angle around the ellipse (0 = head).
        const theta = rng() < 0.68 ? gaussian(rng) * 0.75 : rng() * Math.PI * 2;
        const rad = interior ? Math.sqrt(rng()) * 0.8 : 0.84 + rng() * 0.2;
        const along = Math.cos(theta) * half * rad;
        const across = Math.sin(theta) * (width / 2) * rad;
        const p = offsetPoint(center, ax * along + ay * across, ay * along - ax * across);
        const headFactor = 0.55 + 0.45 * Math.max(0, Math.cos(theta));
        const frp = interior
          ? Math.exp(0.5 + gaussian(rng) * 0.6)
          : Math.exp(1.7 + gaussian(rng) * 0.85) * fire.intensity * headFactor * (pass.day ? 1.5 : 1);
        const conf = frp > 18 ? (rng() < 0.7 ? 'high' : 'nominal') : frp < 2 && rng() < 0.4 ? 'low' : 'nominal';
        fireDets.push({
          id: `${pass.sensor.split('_')[1].toLowerCase()}-${stamp(pass.t)}-${fire.id.slice(4, 10)}-${k}`,
          lon: Math.round(p[0] * 1e5) / 1e5,
          lat: Math.round(p[1] * 1e5) / 1e5,
          acquired_at: toIso(pass.t + Math.round(rng() * 90) * 1000),
          sensor: pass.sensor,
          frp_mw: Math.round(frp * 10) / 10,
          confidence: conf,
          display_weight: Math.min(1, Math.log10(frp + 1) / 2.4),
          daynight: pass.day ? 'D' : 'N',
          incident_id: fire.id,
        });
      }
    }
    detections.push(...fireDets);

    // Sample "official" perimeter: lags activity by ~5 h, only for fires older than 10 h.
    let geometry: Incident['geometry'] = null;
    let acres: number | null = null;
    let updated: number | null = null;
    const lagged = fireDets.filter((d) => Date.parse(d.acquired_at) < now - 5 * HOUR_MS);
    if (fire.ageH > 10 && lagged.length > 6) {
      geometry = outlineAround(
        lagged.map((d) => [d.lon, d.lat] as LngLat),
        { sigmaKm: 0.55, threshold: 0.45 },
      );
      if (geometry) {
        acres = Math.round(areaKm2(geometry) * KM2_TO_ACRES);
        updated = Math.max(...lagged.map((d) => Date.parse(d.acquired_at))) + 75 * 60_000;
      }
    }
    incidents.push({
      id: fire.id,
      name: fire.name,
      official: true,
      source: 'Sample incident record (stands in for CAL FIRE / NIFC)',
      updated_at: updated ? toIso(updated) : toIso(now - 2 * HOUR_MS),
      acres,
      containment_pct: geometry ? fire.containment : null,
      status: fire.status,
      url: null,
      geometry,
      center: fire.origin,
    });
  });

  let s = 0;
  for (const area of SCATTER_AREAS)
    for (let k = 0; k < area.n; k++) {
      const rng = mulberry32(Math.floor(hash2(s, 999, seed) * 2 ** 32));
      const passes = overpasses(ref, 48, area.box[0]);
      const pass = passes[Math.floor(rng() * passes.length)];
      const frp = Math.exp(0.8 + gaussian(rng) * 0.7);
      detections.push({
        id: `${pass.sensor.split('_')[1].toLowerCase()}-${stamp(pass.t)}-iso-${s++}`,
        lon: Math.round((area.box[0] + rng() * (area.box[2] - area.box[0])) * 1e5) / 1e5,
        lat: Math.round((area.box[1] + rng() * (area.box[3] - area.box[1])) * 1e5) / 1e5,
        acquired_at: toIso(pass.t + Math.round(rng() * 90) * 1000),
        sensor: pass.sensor,
        frp_mw: Math.round(frp * 10) / 10,
        confidence: rng() < 0.3 ? 'low' : 'nominal',
        display_weight: Math.min(1, Math.log10(frp + 1) / 2.4),
        daynight: pass.day ? 'D' : 'N',
        incident_id: null,
      });
    }

  detections.sort((a, b) => Date.parse(b.acquired_at) - Date.parse(a.acquired_at));
  return { detections, incidents, generatedAt: now - 7 * 60_000 };
}
