/** Live integration only: running real FastAPI + Vite, installed Chrome, no API mocks. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const url = process.env.FIREWATCH_E2E_URL ?? 'http://127.0.0.1:5175/?api=http%3A%2F%2F127.0.0.1%3A8002%2Fapi%2Fv1';
const out = process.env.FIREWATCH_E2E_OUTPUT ?? path.join(os.tmpdir(), 'firewatch-location-verification');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const results = { url, steps: [], network: [], javascriptErrors: [], weatherFailures: [] };
const pending = [];
page.on('pageerror', error => results.javascriptErrors.push(error.message));
page.on('requestfailed', request => {
  if (/\/api\/v1\/(weather|wind|locations)/.test(request.url()))
    results.weatherFailures.push({ url: request.url(), error: request.failure()?.errorText });
});
page.on('response', response => {
  if (!/\/api\/v1\/(weather|wind|locations)/.test(response.url())) return;
  pending.push((async () => {
    const body = await response.json().catch(() => null);
    results.network.push({ url: response.url(), status: response.status(), cors: response.headers()['access-control-allow-origin'],
      forecast_hour: body?.forecast_hour ?? body?.metadata?.forecast_hour, source: body?.source ?? body?.metadata?.source,
      fetched_at: body?.fetched_at ?? body?.metadata?.fetched_at, cache_status: body?.cache_status ?? body?.metadata?.cache_status });
  })());
});

async function state() {
  return page.evaluate(async () => {
    const { getState, validTimeOf } = await import('/src/state/store.ts');
    const { weatherAtPoint } = await import('/src/state/lookups.ts');
    const s = getState(), p = s.highlight?.place, t = validTimeOf(s);
    const map = window.__fwMap;
    return { id: p?.id, center: p?.center, boundary: s.highlight?.boundary?.id,
      hour: new Date(t).toISOString(), weatherState: s.weather.state, weatherOrigin: s.weather.origin,
      weatherLocation: s.weather.data?.metadata.location_id, weatherHour: s.weather.data?.metadata.forecast_start,
      weather: p ? weatherAtPoint(s.weather.data, p.center, t) : null, weatherError: s.weather.error,
      mapCenter: map?.getCenter().toArray(), zoom: map?.getZoom(),
      highlightSource: map?.getSource('fw-highlight')?.serialize()?.data,
      // source names are read below when asserting the actual map sources
      sources: map ? Object.fromEntries(Object.entries(map.getStyle().sources).filter(([id]) => id.includes('highlight') || id.includes('wind')).map(([id]) => [id, map.getSource(id)?.serialize()?.data])) : {},
      layers: map?.getStyle().layers.filter(layer => layer.id.includes('highlight')).map(layer => layer.id),
    };
  });
}

async function settled(id) {
  await page.waitForFunction(async expected => {
    const { getState, validTimeOf } = await import('/src/state/store.ts');
    const s = getState();
    return s.highlight?.place.id === expected && s.highlight.boundary?.id === expected &&
      s.weather.state === 'ready' && s.weather.data?.metadata.location_id === expected &&
      Date.parse(s.weather.data.metadata.forecast_start) === validTimeOf(s);
  }, id, { timeout: 90_000 });
  await page.waitForTimeout(300);
  const s = await state();
  assert.equal(s.weatherOrigin, 'api'); assert.equal(s.weather.source, 'Open-Meteo');
  assert.ok(Number.isFinite(s.weather.temperature_c));
  assert.ok(s.weather.sampling_coordinates);
  assert.ok(Object.values(s.sources).some(source => source?.features?.some(f => f.id === id)));
  assert.ok(Object.values(s.sources).some(source => source?.features?.some(f => Number.isFinite(f.properties?.s))));
  assert.ok(s.layers.length >= 2);
  return s;
}

async function choose(query, id, keyboard = false) {
  const box = page.getByRole('combobox');
  await box.fill(query);
  const option = page.getByRole('option').filter({ hasText: query }).first();
  await option.waitFor({ state: 'visible' });
  if (keyboard) {
    await box.press('ArrowDown');
    if (query === 'Sacramento') {
      await page.waitForFunction(() => document.querySelector('[role="option"][aria-selected="true"]')?.textContent?.includes('Sacramento County'));
    }
    await box.press('ArrowUp'); await box.press('Enter');
  } else await option.click();
  return settled(id);
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__fwMap?.loaded(), { timeout: 60_000 });
  await page.evaluate(async () => {
    const { setState } = await import('/src/state/store.ts');
    setState(s => ({ units: 'metric', layers: { ...s.layers, wind: true } }));
  });
  const stockton = await choose('Stockton', 'place-ca-stockton', true);
  results.steps.push({ name: 'Stockton search, keyboard selection, boundary, camera, weather, wind', status: 'PASS', state: stockton });
  assert.ok(Math.abs(stockton.mapCenter[0] - stockton.center[0]) < 1);
  await page.getByRole('button', { name: 'Next hour', exact: true }).click();
  await page.waitForFunction(async previous => {
    const { getState, validTimeOf } = await import('/src/state/store.ts');
    const s = getState();
    return validTimeOf(s) > Date.parse(previous) && s.weather.state === 'ready' &&
      Date.parse(s.weather.data?.metadata.forecast_start) === validTimeOf(s);
  }, stockton.hour, { timeout: 60_000 });
  const next = await settled('place-ca-stockton');
  assert.equal(Date.parse(next.hour) - Date.parse(stockton.hour), 3_600_000);
  results.steps.push({ name: 'Shared forecast-hour selection', status: 'PASS', state: next });
  await page.screenshot({ path: path.join(out, 'stockton-desktop.png') });

  const sacramento = await choose('Sacramento', 'place-ca-sacramento', true);
  assert.equal(sacramento.hour, next.hour);
  assert.notDeepEqual(sacramento.mapCenter, next.mapCenter);
  assert.ok(!Object.values(sacramento.sources).some(source => source?.features?.some(f => f.id === 'place-ca-stockton')));
  results.steps.push({ name: 'Sacramento boundary replacement and timeline preservation', status: 'PASS', state: sacramento });
  const zip = await choose('95202', 'zip-95202');
  assert.equal(zip.hour, next.hour);
  assert.match(await page.locator('.panel').innerText(), /ZCTA approximations/);
  assert.match(await page.locator('.panel').innerText(), /Sample:.*coarse weather anchor/s);
  results.steps.push({ name: '95202 ZCTA boundary, labeling, live weather and wind', status: 'PASS', state: zip });

  for (const [name, width, height] of [['tablet', 820, 1180], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
    const box = await page.getByRole('combobox').boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(out, `zip-${name}.png`) });
    results.steps.push({ name: `${name} layout/search viewport`, status: 'PASS' });
  }

  await context.setOffline(true);
  await page.evaluate(async () => {
    const { loadWeather } = await import('/src/state/data.ts');
    await loadWeather(true);
  });
  const failed = await state();
  assert.equal(failed.weatherState, 'error'); assert.equal(failed.weather, null);
  assert.match(await page.locator('.panel').innerText(), /unavailable/i);
  results.steps.push({ name: 'Backend unreachable, explicit unavailable state without demo fallback', status: 'PASS', state: failed });
  await context.setOffline(false);
  await page.evaluate(async () => { await (await import('/src/state/data.ts')).loadWeather(true); });
  await settled('zip-95202');
  results.steps.push({ name: 'Backend recovery', status: 'PASS' });
  await page.screenshot({ path: path.join(out, 'recovered-mobile.png') });

  await page.setViewportSize({ width: 1440, height: 1000 });
  const county = await choose('San Joaquin County', 'county-ca-san-joaquin');
  assert.match(await page.locator('.panel').innerText(), /does not describe every part of this county/);
  results.steps.push({ name: 'County representative weather and boundary', status: 'PASS', state: county });
  await Promise.allSettled(pending);
  for (const response of results.network.filter(r => r.status === 200 && /\/(weather|wind)\?/.test(r.url))) {
    assert.equal(Date.parse(response.forecast_hour), Date.parse(new URL(response.url).searchParams.get('hour')));
    assert.equal(response.source, 'Open-Meteo');
    assert.equal(response.cors, new URL(url).origin);
  }
  assert.equal(results.javascriptErrors.length, 0);
  results.status = 'PASS';
} catch (error) {
  results.status = 'FAIL'; results.error = error.stack;
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await Promise.allSettled(pending);
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ status: results.status, steps: results.steps.map(s => ({ name: s.name, status: s.status })),
    networkResponses: results.network.length, javascriptErrors: results.javascriptErrors, output: out }));
  await browser.close();
}
