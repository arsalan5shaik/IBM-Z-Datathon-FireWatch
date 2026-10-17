/** Static geography shipped with the frontend (built by scripts/build-geodata.mjs). Cached, lazy. */
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { DATA_URL } from '../config';
import type { CellProps, PlaceResult } from '../types';
import { fetchJson } from './http';

const memo = new Map<string, Promise<unknown>>();
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = memo.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load().catch((err) => {
      memo.delete(key); // allow retry after a failure
      throw err;
    });
    memo.set(key, p);
  }
  return p;
}

type Area = Polygon | MultiPolygon;
export type AreaCollection = FeatureCollection<Area, { id: string; name?: string; county?: string }>;

export const loadCaBoundary = () => once('ca', () => fetchJson<FeatureCollection<MultiPolygon>>(DATA_URL('ca-boundary.geojson')));
export const loadCounties = () => once('counties', () => fetchJson<AreaCollection>(DATA_URL('ca-counties.geojson')));
export const loadPlaceIndex = () =>
  once('places', async () => (await fetchJson<{ results: PlaceResult[] }>(DATA_URL('places.json'))).results);
export const loadSampleCells = () =>
  once('cells', () => fetchJson<FeatureCollection<Area, CellProps>>(DATA_URL('grid/cells.geojson')));

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Boundary polygon for a search result (county, place or ZIP area). */
export async function loadBoundary(place: PlaceResult): Promise<Feature<Area> | null> {
  let fc: AreaCollection;
  if (place.type === 'county') fc = await loadCounties();
  else if (place.type === 'zip') fc = await once(`zip-${place.name.slice(0, 3)}`, () => fetchJson<AreaCollection>(DATA_URL(`boundaries/zcta/${place.name.slice(0, 3)}.geojson`)));
  else if (place.county) {
    const shard = slug(place.county);
    fc = await once(`places-${shard}`, () => fetchJson<AreaCollection>(DATA_URL(`boundaries/places/${shard}.geojson`)));
  } else return null;
  return fc.features.find((f) => (f.id ?? f.properties?.id) === place.id) ?? null;
}
