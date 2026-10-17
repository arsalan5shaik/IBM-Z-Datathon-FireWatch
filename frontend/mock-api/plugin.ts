/**
 * Dev-only mock of the FireWatch backend (routes from FireWatch_Backend_Architecture.md §7).
 * Shapes follow backend/app for the implemented routes (/status, /forecasts/risk, /forecasts/cell)
 * and the architecture descriptions for planned ones. Data comes from the browser sample generator.
 *
 *   FIREWATCH_MOCK_API=1 npm run dev           then open  http://localhost:5173/?api=/api/v1
 *   FIREWATCH_MOCK_CHAT=503                    makes /chat fail (exercises the offline fallback)
 *   FIREWATCH_MOCK_MAX_CELLS=2000              per-request cell cap (backend MAX_RESPONSE_CELLS)
 *   FIREWATCH_MOCK_ONLY=forecasts              serve only the implemented backend routes; others 404
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

type Json = Record<string, unknown>;
type Cell = { id: string; properties: Json; geometry: { type: string; coordinates: unknown } };
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const HOUR = 3_600_000;

function geomBounds(g: Cell['geometry']): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as number[];
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  visit(g.coordinates);
  return [w, s, e, n];
}

export function mockApi(): Plugin {
  let provider: Json | null = null;
  let search: ((index: unknown[], q: string) => { results: unknown[] }) | null = null;
  let places: unknown[] | null = null;
  let grid: { metadata: Json; cells: Cell[]; scores: Float32Array; bounds: [number, number, number, number][] } | null = null;
  const startedAt = new Date().toISOString();

  async function load(server: ViteDevServer) {
    if (provider) return;
    const publicDir = resolve(server.config.root, 'public');
    // The sample provider fetches its static grid; serve those reads from public/.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/') || url.startsWith('./')) {
        const body = readFileSync(resolve(publicDir, url.replace(/^\.?\//, '')), 'utf8');
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const mod = await server.ssrLoadModule('/src/mock/sampleProvider.ts');
    provider = new mod.SampleProvider() as Json;
    search = (await server.ssrLoadModule('/src/lib/search.ts')).searchPlaces;
    places = JSON.parse(readFileSync(resolve(publicDir, 'data/places.json'), 'utf8')).results;
    const g = await call<{ metadata: Json; cells: Cell[]; scores: Float32Array }>('getRisk');
    grid = { ...g, bounds: g.cells.map((c) => geomBounds(c.geometry)) };
  }

  const call = <T>(name: string, ...args: unknown[]) => (provider![name] as (...a: unknown[]) => Promise<T>)(...args);
  const windowStart = () => Date.parse(String(grid!.metadata.forecast_start));
  const forecastMeta = () => ({
    data_mode: 'fixture',
    source: 'mock_fixture',
    published_at: String(grid!.metadata.generated_at),
    active_window_start: iso(windowStart()),
    active_window_end_exclusive: iso(windowStart() + 168 * HOUR),
    model_version: 'demo-v0-sample',
    feature_version: 'demo-features-v0',
    input_revision: 'sample-weather',
    grid_version: 'sample-hex-14km',
    grid_resolution_m: 3000,
    stale: false,
    risk_categories: { low: [0, 0.4], elevated: [0.4, 0.7], high: [0.7, 1] },
    risk_colors: { low: 'orange', elevated: 'red', high: 'purple' },
  });
  const parseBbox = (v: string | null) => {
    const b = (v ?? '').split(',').map(Number);
    return b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3] ? (b as [number, number, number, number]) : null;
  };

  return {
    name: 'firewatch-mock-api',
    apply: 'serve',
    configureServer(server) {
      if (!process.env.FIREWATCH_MOCK_API) return;
      const maxCells = Number(process.env.FIREWATCH_MOCK_MAX_CELLS ?? 2000);
      const onlyForecasts = process.env.FIREWATCH_MOCK_ONLY === 'forecasts';
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/v1/')) return next();
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname.replace('/api/v1', '');
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(body));
        };
        const fail = (status: number, code: string, message: string) => send(status, { error: { code, message, details: {} } });
        try {
          await load(server);

          // ---- implemented in backend/ ---------------------------------------------------
          if (path === '/status') {
            const md = forecastMeta();
            return send(200, {
              status: 'degraded',
              api_version: 'v1',
              service_version: '0.1.0',
              checked_at: new Date().toISOString(),
              started_at: startedAt,
              runtime_arch: 'mock',
              data_mode: 'fixture',
              api: { status: 'healthy', stale: false },
              forecast: {
                status: 'healthy',
                stale: false,
                last_success_at: md.published_at,
                active_window_start: md.active_window_start,
                active_window_end_exclusive: md.active_window_end_exclusive,
                valid_hour_count: 168,
                missing_hour_count: 0,
                model_version: md.model_version,
                feature_version: md.feature_version,
                grid_version: md.grid_version,
                input_revision: md.input_revision,
              },
              providers: Object.fromEntries(
                ['firms', 'weather', 'incidents', 'chatbot'].map((k) => [k, onlyForecasts ? { status: 'unavailable', stale: true } : { status: 'healthy', stale: false, last_success_at: new Date(Date.now() - 6 * 60_000).toISOString() }]),
              ),
              scheduler: { enabled: false, owner: 'unassigned' },
            });
          }

          if (path === '/forecasts/risk') {
            const hour = url.searchParams.get('hour');
            const date = url.searchParams.get('date');
            if (!hour === !date) return fail(422, 'invalid_time_selection', 'Specify exactly one of hour or date');
            const bbox = parseBbox(url.searchParams.get('bbox'));
            if (!bbox || (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > 110) return fail(422, 'invalid_bbox', 'Invalid or excessive WGS84 bbox');
            const g = grid!;
            const hits: number[] = [];
            g.bounds.forEach((b, i) => {
              if (b[0] <= bbox[2] && b[2] >= bbox[0] && b[1] <= bbox[3] && b[3] >= bbox[1]) hits.push(i);
            });
            if (hits.length > maxCells) return fail(422, 'response_too_large', 'Use a smaller bbox; results are not truncated');
            const n = g.cells.length;
            let frames: number[];
            if (hour) {
              const t = Date.parse(hour);
              if (!Number.isFinite(t) || t % HOUR) return fail(422, 'invalid_hour', 'Hour must be an aware, aligned ISO 8601 timestamp');
              const f = Math.round((t - windowStart()) / HOUR);
              if (f < 0 || f >= 168) return fail(404, 'forecast_hour_unavailable', 'No forecast hours in requested selection');
              frames = [f];
            } else {
              // California calendar date (approximation: PDT offset) — enough for a mock.
              const dayStart = Date.parse(`${date}T07:00:00Z`);
              frames = Array.from({ length: 24 }, (_, k) => Math.round((dayStart + k * HOUR - windowStart()) / HOUR)).filter((f) => f >= 0 && f < 168);
              if (!frames.length) return fail(404, 'forecast_hour_unavailable', 'No forecast hours in requested selection');
            }
            return send(200, {
              type: 'FeatureCollection',
              metadata: {
                ...forecastMeta(),
                aggregation: date ? 'max_hourly_risk' : null,
                aggregation_is_probability: false,
                timezone: date ? 'America/Los_Angeles' : 'UTC',
                expected_hours: date ? 24 : 1,
                coverage_hours: frames.length,
                partial_day: !!date && frames.length !== 24,
                generated_at_max: String(g.metadata.generated_at),
                returned_cells: hits.length,
                truncated: false,
              },
              features: hits.map((i) => {
                const score = round(Math.max(...frames.map((f) => g.scores[f * n + i])));
                return {
                  type: 'Feature',
                  id: g.cells[i].properties.cell_id,
                  geometry: g.cells[i].geometry,
                  properties: {
                    cell_id: g.cells[i].properties.cell_id,
                    risk_score: score,
                    risk_category: score >= 0.7 ? 'high' : score >= 0.4 ? 'elevated' : 'low',
                    score_type: 'relative_risk',
                    target_type: 'sample_hotspot_activity',
                    coverage_hours: frames.length,
                    missing_hours: 0,
                    partial_day: false,
                    ...(date ? { forecast_date: date } : { forecast_hour: hour }),
                  },
                };
              }),
            });
          }

          const cell = path.match(/^\/forecasts\/cell\/([^/]+)$/);
          if (cell) {
            const g = grid!;
            const id = decodeURIComponent(cell[1]);
            const i = g.cells.findIndex((c) => c.properties.cell_id === id);
            if (i < 0) return fail(404, 'cell_not_found', 'Unknown grid cell');
            const n = g.cells.length;
            return send(200, {
              cell_id: id,
              metadata: forecastMeta(),
              hours: Array.from({ length: 168 }, (_, f) => ({
                forecast_hour: iso(windowStart() + f * HOUR),
                risk_score: round(g.scores[f * n + i]),
                missing: false,
                score_type: 'relative_risk',
                target_type: 'sample_hotspot_activity',
                generated_at: String(g.metadata.generated_at),
              })),
            });
          }

          if (onlyForecasts) return fail(404, 'not_found', 'Not Found');

          // ---- planned routes (architecture §7) ------------------------------------------------
          if (path === '/fires/live') {
            const since = Date.parse(url.searchParams.get('since') ?? '') || Date.now() - 24 * HOUR;
            const snap = await call<{ metadata: Json; detections: Json[] }>('getFires', Math.ceil((Date.now() - since) / HOUR));
            return send(200, {
              type: 'FeatureCollection',
              metadata: { source: 'NASA FIRMS (mock)', generated_at: snap.metadata.generated_at, stale: false },
              features: snap.detections.map(({ lon, lat, id, acquired_at, sensor, frp_mw, confidence, daynight, incident_id }) => ({
                type: 'Feature',
                id,
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: { acquired_at, satellite: sensor, frp: frp_mw, confidence, daynight, incident_id },
              })),
            });
          }

          if (path === '/fires/incidents') {
            const snap = await call<{ metadata: Json; incidents: Json[] }>('getIncidents');
            return send(200, {
              type: 'FeatureCollection',
              metadata: { source: 'Official incidents (mock)', generated_at: snap.metadata.generated_at },
              features: snap.incidents.map(({ geometry, id, name, acres, containment_pct, updated_at, status, center }) => ({
                type: 'Feature',
                id,
                geometry,
                properties: { incident_id: id, name, acres, containment_pct, updated_at, status, center, source: 'Mock incident feed' },
              })),
            });
          }

          if (path === '/wind') {
            const t = Date.parse(url.searchParams.get('hour') ?? '') || Date.now();
            const w = await call<Json & { points: [number, number][]; metadata: Json }>('getWeather');
            const m = w.points.length;
            const f = Math.max(0, Math.min(167, Math.floor((t - windowStart()) / HOUR)));
            const at = (k: string, j: number) => round((w[k] as Float32Array)[f * m + j], 1);
            return send(200, {
              type: 'FeatureCollection',
              metadata: { source: 'Open-Meteo (mock)', issued_at: w.metadata.generated_at, valid_at: iso(t), speed_units: 'km/h', direction_convention: 'meteorological_from' },
              features: w.points.map((p, j) => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: p },
                properties: {
                  wind_speed_kmh: at('wind_speed_kmh', j),
                  wind_direction_deg: at('wind_direction_deg', j),
                  wind_gust_kmh: at('wind_gust_kmh', j),
                  temperature_c: at('temperature_c', j),
                  relative_humidity_pct: at('relative_humidity_pct', j),
                  precipitation_mm: at('precipitation_mm', j),
                },
              })),
            });
          }

          const explain = path.match(/^\/explain\/([^/]+)$/);
          if (explain) {
            const at = Date.parse(url.searchParams.get('hour') ?? '') || Date.now();
            const ex = await call<Json>('explain', decodeURIComponent(explain[1]), at);
            return send(200, { ...ex, forecast_hour: ex.valid_at, output_scale: 'log_odds', feature_version: 'demo-features-v0' });
          }

          if (path === '/places/search') {
            const q = url.searchParams.get('q') ?? '';
            const limit = Math.min(20, Number(url.searchParams.get('limit') ?? 8));
            return send(200, { query: q, results: search!(places!, q).results.slice(0, limit) });
          }

          if (path === '/chat' && req.method === 'POST') {
            if (process.env.FIREWATCH_MOCK_CHAT === '503') return fail(503, 'chatbot_unavailable', 'LLM provider unavailable');
            let raw = '';
            for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw || '{}') as { message?: string; context?: Json };
            const ctx = body.context ?? {};
            return send(200, {
              answer: `Mock API answer (no LLM connected). You asked: “${String(body.message ?? '').slice(0, 200)}”. Context — place: ${ctx.place_id ?? 'none'}, cell: ${ctx.cell_id ?? 'none'}, hour: ${ctx.hour ?? 'n/a'}.`,
              citations: [{ dataset: 'risk', as_of: forecastMeta().published_at }],
              disclaimer: 'Not an emergency advice service.',
            });
          }

          return fail(404, 'not_found', 'Not Found');
        } catch (err) {
          return fail(500, 'mock_error', err instanceof Error ? err.message : String(err));
        }
      });
    },
  };
}
