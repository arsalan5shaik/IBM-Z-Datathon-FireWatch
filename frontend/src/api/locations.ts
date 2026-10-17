import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { API_BASE } from '../config';
import type { PlaceResult } from '../types';
import { fetchJson } from './http';
import { loadBoundary } from './static';

export async function searchLocations(q: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  if (!API_BASE) throw new Error('Backend location search requires an API URL');
  const body = await fetchJson<{ results: PlaceResult[] }>(
    `${API_BASE}/locations/search?${new URLSearchParams({ q, limit: '10' })}`, { signal },
  );
  if (!Array.isArray(body.results) || body.results.some(p => p.state !== 'CA' || !p.id ||
    p.center?.length !== 2 || p.bbox?.length !== 4 || p.center.some(v => !Number.isFinite(v))))
    throw new Error('Invalid California location response');
  return body.results;
}

// Only demo mode uses static files. Backend failures remain explicit and retryable.
export function locationBoundary(place: PlaceResult, signal?: AbortSignal): Promise<Feature<Polygon | MultiPolygon> | null> {
  if (!API_BASE) return loadBoundary(place);
  return fetchJson<Feature<Polygon | MultiPolygon>>(
    `${API_BASE}/locations/${encodeURIComponent(place.id)}/boundary`, { signal },
  ).then(feature => {
    if (feature.id !== place.id || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type))
      throw new Error('Invalid location boundary response');
    return feature;
  });
}
