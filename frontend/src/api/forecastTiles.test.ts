import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForecastTiles } from './forecastTiles';
import type { RiskGrid } from '../types';

const HOUR = 3_600_000;
const START = Date.parse('2026-10-17T20:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

// 6 × 6 cells of 0.1° around Paradise.
const CELLS = Array.from({ length: 36 }, (_, k) => {
  const x = -121.9 + (k % 6) * 0.1, y = 39.5 + Math.floor(k / 6) * 0.1;
  return { id: `C${k}`, box: [x, y, x + 0.1, y + 0.1] as const };
});
const score = (k: number, hourIndex: number) => Math.round(((k % 5) / 10 + (hourIndex % 3) / 10) * 1000) / 1000;

/** Minimal stand-in for backend/app/api/v1/forecasts.py (cap of 20 cells per response). */
function fakeBackend() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input, 'http://api');
    calls.push(url.pathname + url.search);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.pathname === '/api/v1/forecasts/risk') {
      const [w, s, e, n] = url.searchParams.get('bbox')!.split(',').map(Number);
      const h = Math.round((Date.parse(url.searchParams.get('hour')!) - START) / HOUR);
      if (h < 0 || h >= 3) return json(404, { error: { code: 'forecast_hour_unavailable', message: 'No forecast hours' } });
      const hits = CELLS.map((c, k) => ({ c, k })).filter(({ c }) => c.box[0] < e && c.box[2] > w && c.box[1] < n && c.box[3] > s);
      if (hits.length > 20) return json(422, { error: { code: 'response_too_large', message: 'Use a smaller bbox' } });
      return json(200, {
        type: 'FeatureCollection',
        metadata: { active_window_start: iso(START), model_version: 'm1', grid_version: 'g1', source: 'ml_artifact' },
        features: hits.map(({ c, k }) => ({
          type: 'Feature',
          id: c.id,
          geometry: { type: 'Polygon', coordinates: [[[c.box[0], c.box[1]], [c.box[2], c.box[1]], [c.box[2], c.box[3]], [c.box[0], c.box[3]], [c.box[0], c.box[1]]]] },
          properties: { cell_id: c.id, risk_score: k === 7 ? null : score(k, h), score_type: 'relative_risk', target_type: 'fire_activity' },
        })),
      });
    }
    const m = url.pathname.match(/^\/api\/v1\/forecasts\/cell\/(.+)$/);
    if (m) {
      const k = Number(m[1].slice(1));
      return json(200, { cell_id: m[1], hours: Array.from({ length: 168 }, (_, h) => ({ forecast_hour: iso(START + h * HOUR), risk_score: h < 3 ? score(k, h) : null, missing: h >= 3 })) });
    }
    return json(404, { error: { code: 'not_found', message: 'Not Found' } });
  });
  return calls;
}

const settle = () => new Promise((r) => setTimeout(r, 150));
afterEach(() => vi.unstubAllGlobals());

describe('ForecastTiles (backend bbox + hour slices)', () => {
  it('loads the visible area, splitting tiles that exceed the cell cap', async () => {
    const calls = fakeBackend();
    let grid: RiskGrid | null = null;
    const tiles = new ForecastTiles('http://api/api/v1', START, (g) => (grid = g));
    expect(tiles.ensureView([-121.95, 39.45, -121.25, 40.15], START + HOUR)).toBe('loading');
    await settle();
    expect(grid!.metadata.sparse).toBe(true);
    expect(grid!.metadata.model_version).toBe('m1');
    expect(grid!.cells).toHaveLength(36);
    expect(calls.some((c) => c.includes('bbox='))).toBe(true);
    const n = grid!.cells.length;
    const at = (id: string, frame: number) => grid!.scores[frame * n + grid!.cells.findIndex((c) => c.properties.cell_id === id)];
    expect(at('C3', 1)).toBeCloseTo(score(3, 1));
    expect(Number.isNaN(at('C7', 1))).toBe(true); // null score stays missing, never zero
    expect(Number.isNaN(at('C3', 0))).toBe(true); // hour not requested yet
    expect(tiles.ensureView([-121.95, 39.45, -121.25, 40.15], START + HOUR)).toBe('ok');
  });

  it('reports hours outside the published window and statewide views', async () => {
    fakeBackend();
    const tiles = new ForecastTiles('http://api/api/v1', START, () => undefined);
    tiles.ensureView([-121.6, 39.6, -121.4, 39.8], START + 10 * HOUR);
    await settle();
    expect(tiles.ensureView([-121.6, 39.6, -121.4, 39.8], START + 10 * HOUR)).toBe('missing-hour');
    expect(tiles.ensureView([-124.5, 32.5, -114.1, 42], START)).toBe('zoom-in');
  });

  it('fills a cell’s hourly history', async () => {
    fakeBackend();
    let grid: RiskGrid | null = null;
    const tiles = new ForecastTiles('http://api/api/v1', START, (g) => (grid = g));
    tiles.ensureView([-121.6, 39.6, -121.4, 39.8], START);
    await settle();
    await tiles.ensureHistory('C16');
    await settle();
    const n = grid!.cells.length;
    const i = grid!.cells.findIndex((c) => c.properties.cell_id === 'C16');
    expect(grid!.scores[2 * n + i]).toBeCloseTo(score(16, 2));
    expect(Number.isNaN(grid!.scores[50 * n + i])).toBe(true);
  });
});
