import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFires } from './fires';
import { RemoteProvider } from './remote';
import { loadFires, loadRisk, loadIncidents } from '../state/data';
import { getState, setState, setTimeIndex, togglePlay } from '../state/store';

vi.mock('../config', async () => ({ ...await vi.importActual('../config'), API_BASE: 'http://test/api/v1' }));
const initial = getState();
const NOW = '2026-10-17T21:38:00Z';
function payload(features = 1) {
  return { type: 'FeatureCollection', metadata: { source: 'NASA FIRMS', cache_status: 'fresh', last_successful_refresh: NOW, returned_count: features, matched_count: features, truncated: false },
    features: Array.from({ length: features }, (_, i) => ({ type: 'Feature', id: `firms-${i}`, geometry: { type: 'Point', coordinates: [-121.5, 38.5] }, properties: { acquired_at: '2026-10-17T21:31:00Z', satellite: 'NOAA-20', frp: 12.4, confidence: 'n' } })) };
}
beforeEach(() => { setState({ ...initial }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('NASA GeoJSON integration', () => {
  it('preserves identity, coordinate ordering, UTC, MW and categorical confidence', () => {
    const result = parseFires(payload(), 48);
    expect(result.detections[0]).toMatchObject({ id: 'firms-0', lon: -121.5, lat: 38.5, acquired_at: '2026-10-17T21:31:00.000Z', frp_mw: 12.4, confidence: 'n' });
    expect(result.metadata.last_successful_refresh).toBe('2026-10-17T21:38:00.000Z');
    expect(result.metadata.cache_status).toBe('fresh');
  });
  it('distinguishes valid empty data, unavailable data and malformed data', () => {
    expect(parseFires(payload(0), 48).detections).toEqual([]);
    expect(() => parseFires({ ...payload(0), metadata: { ...payload(0).metadata, cache_status: 'unavailable' } }, 48)).toThrow('unavailable');
    expect(() => parseFires({ type: 'FeatureCollection' }, 48)).toThrow('Invalid');
    expect(() => parseFires({ ...payload(), metadata: {} }, 48)).toThrow('Invalid');
  });
  it('retains stale, partial-source and truncation information', () => {
    const value = payload();
    const result = parseFires({ ...value, metadata: { ...value.metadata, cache_status: 'stale', matched_count: 698, truncated: true, partial_sources: true, refresh_errors: { VIIRS_NOAA21_NRT: 'timeout' } } }, 48);
    expect(result.metadata).toMatchObject({ stale: true, truncated: true, returned_count: 1, matched_count: 698, partial_sources: true, refresh_errors: { VIIRS_NOAA21_NRT: 'timeout' } });
  });
  it.each(['coordinates', 'time', 'frp', 'id', 'duplicate'])('rejects invalid %s without manufacturing replacement records', (field) => {
    const value = payload();
    if (field === 'coordinates') value.features[0].geometry.coordinates = [181, 38];
    if (field === 'time') value.features[0].properties.acquired_at = '2026-10-17T21:31:00';
    if (field === 'frp') value.features[0].properties.frp = -1;
    if (field === 'id') value.features[0].id = '';
    if (field === 'duplicate') value.features.push(value.features[0]);
    expect(() => parseFires(value, 48)).toThrow('Invalid');
  });
  it('calls the authoritative route and preserves the source measurement', async () => {
    let url = '';
    vi.stubGlobal('fetch', async (input: string) => { url = input; return new Response(JSON.stringify(payload())); });
    const result = await new RemoteProvider('http://test/api/v1').getFires(48);
    expect(new URL(url).pathname).toBe('/api/v1/fires/live');
    expect(new URL(url).searchParams.has('since')).toBe(true);
    expect(result.detections[0].frp_mw).toBe(12.4);
  });
  it('exposes loading, and never substitutes sample observations on a 503', async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(RemoteProvider.prototype, 'getFires').mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const promise = loadFires();
    expect(getState().fires.state).toBe('loading');
    reject(new Error('Satellite observations unavailable'));
    await promise;
    expect(getState().fires).toMatchObject({ state: 'error', origin: 'api', data: null });
  });
  it('retains last-good observations with an explicit stale flag after a failed refresh', async () => {
    const data = parseFires(payload(), 48);
    setState({ fires: { state: 'ready', data, origin: 'api', error: null, at: 1 } });
    vi.spyOn(RemoteProvider.prototype, 'getFires').mockRejectedValue(new Error('Network unavailable'));
    await loadFires();
    expect(getState().fires.data?.detections).toEqual(data.detections);
    expect(getState().fires.data?.metadata.cache_status).toBe('stale');
    expect(getState().fires.error).toContain('Network');
  });
  it('never attaches sample official incidents to real observations on an outage', async () => {
    vi.spyOn(RemoteProvider.prototype, 'getIncidents').mockRejectedValue(new Error('Network unavailable'));
    await loadIncidents();
    expect(getState().incidents).toMatchObject({ state: 'error', origin: 'api', data: null });
  });
  it('requires the explanation endpoint to declare its scale instead of inventing a logistic probability', async () => {
    const value = { risk_score: .42, base_value: .1, raw_score: .3, drivers: [] };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(value)));
    const provider = new RemoteProvider('http://test/api/v1');
    await expect(provider.explain('test-cell', Date.now())).rejects.toThrow('output scale');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ...value, output_scale: 'raw_model_score' })));
    expect(await provider.explain('test-cell', Date.now())).toMatchObject({ risk_score: .42, output_scale: 'raw_model_score' });
  });
  it('keeps forecast_not_ready visible rather than generating sample predictions', async () => {
    vi.spyOn(RemoteProvider.prototype, 'getRisk').mockRejectedValue(new Error('forecast_not_ready: waiting for validated artifacts'));
    await loadRisk();
    expect(getState().risk).toMatchObject({ state: 'error', origin: 'api', data: null });
    expect(getState().playing).toBe(false);
    setTimeIndex(24); togglePlay();
    expect(getState().isLive).toBe(true);
    expect(getState().playing).toBe(false);
  });
});
