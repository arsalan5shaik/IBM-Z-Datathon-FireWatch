import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteProvider } from './remote';
import { loadWeather } from '../state/data';
import { getState, setState, validTimeOf } from '../state/store';
import { weatherAtPoint, weatherFrame } from '../state/lookups';
import { windFeatures, windToward } from '../map/weatherFeatures';
import { HOUR_MS } from '../lib/time';
import type { WeatherGrid } from '../types';

vi.mock('../config', async () => ({ ...await vi.importActual('../config'), API_BASE: 'http://test/api/v1' }));

const NOW = Date.parse('2026-10-17T12:00:00Z');
const initial = getState();
function grid(hour = NOW, stale = false): WeatherGrid {
  return {
    metadata: { generated_at: new Date(NOW).toISOString(), fetched_at: new Date(NOW).toISOString(),
      source: 'Open-Meteo', forecast_start: new Date(hour).toISOString(), frames: 1, step_minutes: 60,
      cache_status: stale ? 'stale' : 'fresh', data_kind: 'forecast' },
    points: [[-120, 36.5], [-121, 39]], temperature_c: new Float32Array([20, 25]),
    relative_humidity_pct: new Float32Array([30, 40]), precipitation_mm: new Float32Array([0, 0]),
    wind_speed_kmh: new Float32Array([36, 18]), wind_direction_deg: new Float32Array([90, 0]),
    wind_gust_kmh: new Float32Array([40, 20]),
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); setState({ ...initial, now: NOW }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('weather forecast integration', () => {
  it('parses the existing wind endpoint with units, freshness and selected UTC hour', async () => {
    let url = '';
    vi.stubGlobal('fetch', async (input: string) => {
      url = input;
      return new Response(JSON.stringify({ type: 'FeatureCollection', metadata: {
        forecast_hour: new Date(NOW).toISOString(), fetched_at: new Date(NOW).toISOString(),
        source: 'Open-Meteo', cache_status: 'stale', complete: false,
      }, features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-120, 36.5] },
        properties: { temperature_c: 20, relative_humidity_pct: 30, precipitation_mm: 0,
          wind_speed_ms: 10, wind_direction_deg: 90, wind_gust_kmh: 40 } }] }));
    });
    const result = await new RemoteProvider('http://test/api/v1').getWeather(NOW);
    expect(Date.parse(new URL(url).searchParams.get('hour')!)).toBe(NOW);
    expect(result.wind_speed_kmh[0]).toBe(36);
    expect(result.metadata.cache_status).toBe('stale');
    expect(result.metadata.complete).toBe(false);
  });

  it('rejects mismatched forecast hours and provider errors', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ metadata: { forecast_hour: new Date(NOW+HOUR_MS).toISOString() } })));
    await expect(new RemoteProvider('http://test').getWeather(NOW)).rejects.toThrow('hour');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'weather_unavailable', message: 'Weather unavailable' } }), { status: 503 }));
    await expect(new RemoteProvider('http://test').getWeather(NOW)).rejects.toThrow('Weather unavailable');
  });

  it('updates panels by selected location and rejects missing hours', () => {
    const data = grid();
    expect(weatherAtPoint(data, [-120, 36.5], NOW)?.temperature_c).toBe(20);
    expect(weatherAtPoint(data, [-121, 39], NOW)?.temperature_c).toBe(25);
    expect(weatherAtPoint(data, [-120, 36.5], NOW+HOUR_MS)).toBeNull();
    expect(weatherFrame(data, NOW-HOUR_MS)).toBe(-1);
    expect(windFeatures(data, NOW+HOUR_MS, new Uint8Array([0, 0]))).toEqual([]);
    expect(windFeatures(data, NOW, new Uint8Array([0, 0]))[0].properties.d).toBe(270);
    expect(windToward(0)).toBe(180);
  });

  it('loads the shared timeline hour and exposes loading and stale states', async () => {
    const fetch = vi.spyOn(RemoteProvider.prototype, 'getWeather').mockResolvedValue(grid(NOW, true));
    const promise = loadWeather(true);
    expect(getState().weather.state).toBe('loading');
    await promise;
    expect(fetch).toHaveBeenCalledWith(validTimeOf(getState()));
    expect(getState().weather.data?.metadata.cache_status).toBe('stale');
    expect(getState().weather.error).toContain('stale');
  });

  it('a slower prior-hour request cannot overwrite the current timeline hour', async () => {
    let resolve!: (value: WeatherGrid) => void;
    vi.spyOn(RemoteProvider.prototype, 'getWeather')
      .mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValueOnce(grid(NOW+HOUR_MS));
    const old = loadWeather(true);
    setState({ isLive: false, timeIndex: 1 });
    await loadWeather(true);
    resolve(grid(NOW));
    await old;
    expect(getState().weather.data?.metadata.forecast_start).toBe(new Date(NOW+HOUR_MS).toISOString());
  });

  it('keeps explicit errors without replacing unavailable API weather with samples', async () => {
    setState({ weather: { state: 'ready', data: grid(), origin: 'fallback', error: null, at: NOW } });
    vi.spyOn(RemoteProvider.prototype, 'getWeather').mockRejectedValue(new Error('Missing forecast hour'));
    await loadWeather(true);
    expect(getState().weather.origin).toBe('api');
    expect(getState().weather.state).toBe('error');
    expect(getState().weather.data).toBeNull();
  });
});
