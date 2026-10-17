import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchLocations, locationBoundary } from './locations';
import { RemoteProvider } from './remote';
import { loadWeather } from '../state/data';
import { choosePlace, clearSearch } from '../state/actions';
import { getState, setState, validTimeOf } from '../state/store';
import { weatherAtPoint } from '../state/lookups';
import { fetchJson } from './http';
import type { PlaceResult, WeatherGrid } from '../types';

vi.mock('../config', async () => ({ ...await vi.importActual('../config'), API_BASE: 'https://backend.test/api/v1' }));
vi.mock('../map/mapRef', () => ({ fitBbox: vi.fn(), flyToPoint: vi.fn() }));

const stockton: PlaceResult = { id: 'place-ca-stockton', name: 'Stockton', type: 'city', state: 'CA', county: 'San Joaquin', center: [-121.2881, 37.9498], bbox: [-121.4188, 37.8675, -121.1839, 38.0588] };
const sacramento: PlaceResult = { ...stockton, id: 'place-ca-sacramento', name: 'Sacramento', center: [-121.4674, 38.5783] };
const NOW = Date.parse('2026-10-17T12:00:00Z');
const initial = getState();
function grid(id: string): WeatherGrid {
  return { metadata: { generated_at: new Date(NOW).toISOString(), source: 'Open-Meteo', forecast_start: new Date(NOW).toISOString(), frames: 1, step_minutes: 60, location_id: id },
    points: [[-121.5, 38]], temperature_c: new Float32Array([20]), relative_humidity_pct: new Float32Array([30]), precipitation_mm: new Float32Array([0]), wind_speed_kmh: new Float32Array([10]), wind_direction_deg: new Float32Array([90]), wind_gust_kmh: new Float32Array([15]) };
}
const json = (body: unknown) => new Response(JSON.stringify(body));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); setState({ ...initial, now: NOW, highlight: null }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); clearSearch(); });

describe('backend location selection', () => {
  it('parses California suggestions and rejects malformed or out-of-state responses', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ results: [stockton] }))
      .mockResolvedValueOnce(json({ results: [{ ...stockton, state: 'NV' }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await searchLocations('Stockton')).toEqual([stockton]);
    expect(String(fetch.mock.calls[0][0])).toContain('/locations/search?q=Stockton&limit=10');
    await expect(searchLocations('Reno')).rejects.toThrow('Invalid California');
  });

  it('keeps boundary failures explicit rather than substituting static geography', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"code":"boundary_invalid","message":"Boundary invalid"}}', { status: 503 })));
    await expect(locationBoundary(stockton)).rejects.toThrow('Boundary invalid');
  });

  it('fits the existing camera and ignores a slower old boundary, including ABA switches', async () => {
    const requests: ((body: Response) => void)[] = [];
    vi.stubGlobal('fetch', () => new Promise<Response>(resolve => requests.push(resolve)));
    const a = choosePlace(stockton); const b = choosePlace(sacramento); const c = choosePlace(stockton);
    const feature = (p: PlaceResult) => ({ type: 'Feature', id: p.id, properties: {}, geometry: { type: 'Polygon', coordinates: [[[-121, 38], [-120, 38], [-120, 39], [-121, 38]]] } });
    requests[2](json(feature(stockton))); await c;
    const boundary = getState().highlight?.boundary;
    requests[0](json(feature(stockton))); requests[1](json(feature(sacramento)));
    await Promise.all([a, b]);
    expect(getState().highlight?.place.id).toBe(stockton.id);
    expect(getState().highlight?.boundary).toBe(boundary);
    const { fitBbox } = await import('../map/mapRef');
    expect(fitBbox).toHaveBeenLastCalledWith(stockton.bbox, 12.5);
  });

  it('calls point weather at representative coordinates and wind in a bounded area at the same UTC hour', async () => {
    const urls: URL[] = [];
    const row = { forecast_hour: new Date(NOW).toISOString(), source: 'Open-Meteo', fetched_at: new Date(NOW).toISOString(), longitude: -121.5, latitude: 38,
      provider_longitude: -121.49, provider_latitude: 37.98, cache_status: 'fresh', temperature_c: 22, relative_humidity_pct: 30, precipitation_mm: 0, wind_speed_kmh: 10, wind_direction_deg: 90, wind_gust_kmh: 15 };
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(input); urls.push(url);
      return url.pathname.endsWith('/weather') ? json(row) : json({ type: 'FeatureCollection', metadata: row,
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-121.5, 38] }, properties: row }] });
    });
    const result = await new RemoteProvider('https://backend.test/api/v1').getLocationWeather(stockton, NOW);
    const point = urls.find(u => u.pathname.endsWith('/weather'))!;
    expect(Number(point.searchParams.get('latitude'))).toBe(stockton.center[1]);
    expect(Number(point.searchParams.get('longitude'))).toBe(stockton.center[0]);
    expect(urls.every(u => Date.parse(u.searchParams.get('hour')!) === NOW)).toBe(true);
    expect(urls.find(u => u.pathname.endsWith('/wind'))!.searchParams.get('bbox')).not.toBe('-124.6,32.4,-114.0,42.1');
    expect(result.metadata.location_id).toBe(stockton.id);
    expect(weatherAtPoint(result, stockton.center, NOW)?.sampling_coordinates).toEqual([-121.5, 38]);
  });

  it('clears the old location during loading and blocks slower weather overwrites', async () => {
    let resolve!: (value: WeatherGrid) => void;
    vi.spyOn(RemoteProvider.prototype, 'getLocationWeather').mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValueOnce(grid(sacramento.id));
    setState({ highlight: { place: stockton, boundary: null } });
    const a = loadWeather(true);
    setState({ highlight: { place: sacramento, boundary: null } });
    const hour = validTimeOf(getState());
    const b = loadWeather(true);
    expect(getState().weather.data).toBeNull();
    await b; resolve(grid(stockton.id)); await a;
    expect(getState().weather.data?.metadata.location_id).toBe(sacramento.id);
    expect(validTimeOf(getState())).toBe(hour);
  });

  it('uses the location/hour cache and never displays old or demo weather after a failure', async () => {
    setState({ highlight: { place: stockton, boundary: null } });
    const fetch = vi.spyOn(RemoteProvider.prototype, 'getLocationWeather').mockResolvedValue(grid(stockton.id));
    await loadWeather(true); await loadWeather();
    expect(fetch).toHaveBeenCalledTimes(1);
    setState({ highlight: { place: sacramento, boundary: null } });
    fetch.mockRejectedValue(new Error('Provider unavailable'));
    await loadWeather(true);
    expect(getState().weather.state).toBe('error');
    expect(getState().weather.origin).toBe('api');
    expect(getState().weather.data).toBeNull();
  });

  it('rejects mixed content and already canceled requests before fetching', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { location: { href: 'https://public.test/' } });
    await expect(fetchJson('http://backend.test/api/v1/weather')).rejects.toThrow('HTTPS backend');
    const ctrl = new AbortController(); ctrl.abort();
    await expect(fetchJson('https://backend.test/api/v1/weather', { signal: ctrl.signal })).rejects.toThrow('cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });
});
