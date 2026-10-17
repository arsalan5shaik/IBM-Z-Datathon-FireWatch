/** Convert the existing GeoJSON contract to UI records without manufacturing observations. */
import type { Detection, FiresSnapshot } from '../types';
import { HttpError } from './http';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function invalid(): never { throw new HttpError('invalid_fires_data', 'Invalid satellite observation response'); }

export function utcTimestamp(value: unknown): string | null {
  const input = text(value);
  if (!input || !/(Z|[+-]\d{2}:\d{2})$/i.test(input) || !Number.isFinite(Date.parse(input))) return null;
  return new Date(input).toISOString();
}

export function parseFires(value: unknown, lookbackHours: number): FiresSnapshot {
  const root = object(value), md = object(root.metadata);
  if (root.type !== 'FeatureCollection' || !Array.isArray(root.features) || root.features.length > 5000) invalid();
  if (md.cache_status === 'unavailable') throw new HttpError('firms_unavailable', 'Satellite observations are unavailable');
  const refreshed = utcTimestamp(md.last_successful_refresh ?? md.last_success_at ?? md.fetched_at ?? md.generated_at);
  if (!refreshed) invalid();
  const ids = new Set<string>();
  const detections: Detection[] = root.features.map((value: unknown) => {
    const feature = object(value), geometry = object(feature.geometry), p = object(feature.properties);
    const coordinates = geometry.coordinates;
    const id = text(feature.id) ?? text(p.id) ?? text(p.detection_id);
    const acquired = utcTimestamp(p.acquired_at ?? p.acquisition_time ?? p.observed_at);
    const frp = p.frp_mw ?? p.frp ?? null;
    if (feature.type !== 'Feature' || geometry.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length !== 2 || !coordinates.every(finite)
      || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90 || !id || !acquired || ids.has(id)
      || (frp !== null && (!finite(frp) || frp < 0))) invalid();
    ids.add(id);
    return { id, lon: coordinates[0], lat: coordinates[1], acquired_at: acquired,
      sensor: text(p.satellite) ?? text(p.sensor) ?? text(p.product) ?? 'VIIRS',
      frp_mw: frp, confidence: text(p.confidence) ?? 'unknown', display_weight: 0.5,
      daynight: p.daynight === 'D' || p.daynight === 'N' ? p.daynight : null,
      incident_id: text(p.incident_id) };
  });
  const returned = count(md.returned_count) ?? detections.length;
  const matched = count(md.matched_count) ?? returned;
  if (returned !== detections.length || matched < returned) invalid();
  const stale = md.stale === true || md.cache_status === 'stale';
  const errors = Object.fromEntries(Object.entries(object(md.refresh_errors)).filter((entry): entry is [string, string | null] => entry[1] === null || typeof entry[1] === 'string'));
  return { detections, metadata: {
    source: text(md.source) ?? 'NASA FIRMS', generated_at: refreshed, last_successful_refresh: refreshed,
    last_attempted_refresh: utcTimestamp(md.last_attempted_refresh), observation_start: utcTimestamp(md.observation_start), observation_end: utcTimestamp(md.observation_end),
    cache_status: stale ? 'stale' : md.cache_status === 'fresh' ? 'fresh' : 'unknown', stale,
    cache_age_seconds: finite(md.cache_age_seconds) ? md.cache_age_seconds : null,
    observation_type: text(md.observation_type) ?? 'Satellite-detected thermal anomalies; not confirmed wildfires',
    not_fire_perimeter: true, lookback_hours: lookbackHours, returned_count: returned, matched_count: matched,
    truncated: md.truncated === true || matched > returned, partial_sources: md.partial_sources === true,
    partial_boundary_coverage: md.partial_boundary_coverage === true,
    partial_time_coverage: md.partial_time_coverage === true, partial_observations: md.partial_observations === true, refresh_errors: errors,
  } };
}


export function utcLabel(value: string | null | undefined): string {
  return utcTimestamp(value)?.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') ?? 'Unavailable';
}
