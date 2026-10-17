// Browser contract smoke against the real UI and deterministic mock API responses.
// Start Vite first; no live weather/provider/ML dependency is used by this check.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.FIREWATCH_SMOKE_URL ?? 'http://127.0.0.1:5174';
const browser = await chromium.launch({
  ...(process.env.FIREWATCH_BROWSER_PATH ? { executablePath: process.env.FIREWATCH_BROWSER_PATH } : { channel: 'chrome' }),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const hours = [];
  let outage = false;
  await page.route('https://**', route => route.fulfill({ json: {
    version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eee' } }],
  }, headers: { 'access-control-allow-origin': '*' } }));
  await page.route('**/weather-api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/wind')) {
      if (outage) return route.fulfill({ status: 503, json: { error: { code: 'weather_unavailable', message: 'Mock provider outage' } } });
      const hour = url.searchParams.get('hour');
      hours.push(hour);
      return route.fulfill({ json: { type: 'FeatureCollection', metadata: {
        source: 'Open-Meteo', data_kind: 'forecast', forecast_hour: hour,
        fetched_at: new Date().toISOString(), cache_status: 'stale', complete: false,
      }, features: [[-121.5, 38.5, 20], [-118, 34, 25]].map(([lon, lat, temperature]) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: {
          temperature_c: temperature, relative_humidity_pct: 30, precipitation_mm: 0,
          wind_speed_kmh: 36, wind_direction_deg: 90, wind_gust_kmh: 40,
        },
      })) } });
    }
    if (url.pathname.endsWith('/status')) return route.fulfill({ json: {
      status: 'degraded', data_mode: 'unavailable', forecast: {}, providers: {},
    } });
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Mock: unavailable dataset' } } });
  });
  await page.goto(`${base}/?api=${encodeURIComponent(`${base}/weather-api`)}`);
  await page.waitForFunction(() => window.__fwMap?.getSource('fw-wind'));
  await page.waitForFunction(async () => (await import('/src/state/store.ts')).getState().weather.origin === 'api');
  await page.evaluate(async () => {
    const { getState, setState, select } = await import('/src/state/store.ts');
    setState({ units: 'metric', layers: { ...getState().layers, wind: true } });
    select({ kind: 'place', place: { id: 'weather-smoke-sac', name: 'Sacramento weather fixture', type: 'city',
      state: 'CA', county: null, center: [-121.5, 38.5], bbox: [-121.6, 38.4, -121.4, 38.6] } });
  });
  await page.getByText(/Open-Meteo · forecast/).first().waitFor();
  assert.match(await page.locator('body').innerText(), /20\s*°C/);
  assert.match(await page.locator('body').innerText(), /stale/);
  assert.match(await page.locator('body').innerText(), /partial coverage/);
  await page.waitForFunction(() => window.__fwMap.getSource('fw-wind').serialize().data?.features?.some(f => f.properties.d === 270));
  const firstHour = hours.at(-1);
  await page.getByRole('button', { name: 'Next hour', exact: true }).click();
  await page.waitForFunction(old => {
    const data = window.__fwMap.getSource('fw-wind').serialize().data;
    return data?.features?.length > 0 && document.querySelector('.timeline__range')?.value !== '0';
  }, firstHour);
  await page.waitForTimeout(500); // Existing timeline debounce is 150 ms.
  assert.notEqual(hours.at(-1), firstHour);
  await page.evaluate(async () => {
    const { select } = await import('/src/state/store.ts');
    select({ kind: 'place', place: { id: 'weather-smoke-la', name: 'Los Angeles weather fixture', type: 'city',
      state: 'CA', county: null, center: [-118, 34], bbox: [-118.1, 33.9, -117.9, 34.1] } });
  });
  await page.getByText('Los Angeles weather fixture', { exact: false }).first().waitFor();
  assert.match(await page.locator('body').innerText(), /25\s*°C/);
  outage = true;
  await page.getByRole('button', { name: 'Next hour', exact: true }).click();
  await page.getByText(/Forecast weather is unavailable for this hour/).first().waitFor();
  await page.waitForFunction(() => window.__fwMap.getSource('fw-wind').serialize().data?.features?.length === 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: 'passed', provider: 'mock', checks: [
    'forecast freshness', 'selected location', 'shared timeline', 'wind direction and layer', 'outage and missing-hour clearing',
  ] }));
} finally {
  await browser.close();
}
