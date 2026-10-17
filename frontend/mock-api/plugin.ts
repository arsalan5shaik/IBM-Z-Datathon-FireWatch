/**
 * Dev-only mock of the FireWatch backend. Serves the /api/v1 contract (see API_INTEGRATION.md)
 * from the same sample generator the offline demo uses, so the frontend's API code path can be
 * exercised end to end before the real Python backend exists:
 *
 *   FIREWATCH_MOCK_API=1 npm run dev      then open  http://localhost:5173/?api=/api/v1
 *
 * Optional: FIREWATCH_MOCK_CHAT=503 makes /chat fail so the offline fallback can be tested.
 * It doubles as an executable example of every response shape for the backend team.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

type Json = Record<string, unknown>;
const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

export function mockApi(): Plugin {
  let provider: Json | null = null;
  let search: ((index: unknown[], q: string) => { results: unknown[] }) | null = null;
  let places: unknown[] | null = null;

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
  }

  const call = <T>(name: string, ...args: unknown[]) => (provider![name] as (...a: unknown[]) => Promise<T>)(...args);

  return {
    name: 'firewatch-mock-api',
    apply: 'serve',
    configureServer(server) {
      if (!process.env.FIREWATCH_MOCK_API) return;
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/v1/')) return next();
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname.replace('/api/v1', '');
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        try {
          await load(server);
          if (path === '/status') return send(200, await call('getStatus'));

          if (path === '/fires') {
            const hours = Number(url.searchParams.get('hours') ?? Number(url.searchParams.get('days') ?? 1) * 24);
            const snap = await call<{ metadata: Json; detections: Json[] }>('getFires', hours);
            return send(200, {
              type: 'FeatureCollection',
              metadata: { ...snap.metadata, source: 'NASA FIRMS (mock API)' },
              features: snap.detections.map(({ lon, lat, id, ...p }) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [lon, lat] }, properties: p })),
            });
          }

          if (path === '/incidents') {
            const snap = await call<{ metadata: Json; incidents: Json[] }>('getIncidents');
            return send(200, {
              type: 'FeatureCollection',
              metadata: snap.metadata,
              features: snap.incidents.map(({ geometry, id, ...p }) => ({ type: 'Feature', id, geometry, properties: p })),
            });
          }

          if (path === '/coverage') return send(404, { error: { code: 'not_found', message: 'Coverage is derived by the client in mock mode' } });

          if (path === '/risk/hourly' || path === '/risk') {
            const grid = await call<{ metadata: Json; cells: { properties: Json; geometry: unknown; id?: string }[]; scores: Float32Array }>('getRisk');
            const n = grid.cells.length;
            const frames = Number(grid.metadata.frames);
            const hourly = path === '/risk/hourly';
            return send(200, {
              type: 'FeatureCollection',
              metadata: { ...grid.metadata, source: 'FireWatch model (mock API)', ...(hourly ? {} : { frames: 1, step_minutes: 10080 }) },
              features: grid.cells.map((c, i) => {
                const series = Array.from({ length: frames }, (_, f) => grid.scores[f * n + i]);
                const max = Math.max(...series);
                return {
                  type: 'Feature',
                  id: c.properties.cell_id,
                  geometry: c.geometry,
                  properties: {
                    cell_id: c.properties.cell_id,
                    county: c.properties.county,
                    near: c.properties.near,
                    fuel: c.properties.fuel,
                    risk_score: round(max),
                    score_type: grid.metadata.score_type,
                    explanation_available: true,
                    ...(hourly ? { scores: series.map((v) => round(v)) } : {}),
                  },
                };
              }),
            });
          }

          if (path === '/weather/hourly') {
            const w = await call<Json & { points: unknown[]; metadata: Json }>('getWeather');
            const m = w.points.length;
            const frames = Number(w.metadata.frames);
            const vars = ['temperature_c', 'relative_humidity_pct', 'wind_speed_kmh', 'wind_direction_deg', 'wind_gust_kmh', 'precipitation_mm'];
            return send(200, {
              metadata: { ...w.metadata, source: 'Open-Meteo (mock API)' },
              points: w.points,
              variables: Object.fromEntries(
                vars.map((k) => [k, Array.from({ length: frames }, (_, f) => Array.from((w[k] as Float32Array).subarray(f * m, f * m + m), (v) => round(v, 1)))]),
              ),
            });
          }

          const explain = path.match(/^\/explain\/([^/]+)$/);
          if (explain) {
            const at = Date.parse(url.searchParams.get('valid_at') ?? '') || Date.now();
            return send(200, await call('explain', decodeURIComponent(explain[1]), at));
          }

          if (path === '/places') {
            const q = url.searchParams.get('q') ?? '';
            return send(200, { query: q, results: search!(places!, q).results.slice(0, 20) });
          }

          if (path === '/chat' && req.method === 'POST') {
            if (process.env.FIREWATCH_MOCK_CHAT === '503') return send(503, { error: { code: 'llm_unavailable', message: 'LLM provider unavailable' } });
            let raw = '';
            for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw || '{}') as Json;
            return send(200, {
              answer: `Mock API answer (no LLM connected). You asked: “${String(body.message ?? '').slice(0, 200)}”. Context — place: ${body.location_id ?? 'none'}, cell: ${body.cell_id ?? 'none'}, valid at: ${body.valid_at ?? 'n/a'}.`,
              grounding: [{ dataset: 'risk', as_of: new Date().toISOString() }],
              location_id: body.location_id ?? null,
              disclaimer: 'Not an emergency advice service.',
            });
          }

          return send(404, { error: { code: 'not_found', message: `No mock for ${path}` } });
        } catch (err) {
          return send(500, { error: { code: 'mock_error', message: err instanceof Error ? err.message : String(err) } });
        }
      });
    },
  };
}
