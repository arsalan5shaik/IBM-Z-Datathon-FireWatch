// Optional real-browser check: npm ci in frontend, then start the Compose stack.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const { chromium } = require(process.env.FIREWATCH_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.FIREWATCH_BROWSER_URL || 'http://127.0.0.1:8080';
const browser = await chromium.launch({
  channel: process.env.FIREWATCH_BROWSER_CHANNEL || 'chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  const api = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().startsWith(`${base}/api/v1/`)) {
      api.push({ path: new URL(response.url()).pathname, status: response.status() });
    }
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    // Exercise the real same-origin API; block external tiles and all on-demand
    // weather routes so browser verification cannot trigger a provider call.
    if (url.origin !== new URL(base).origin || /^\/api\/v1\/(weather|wind)/.test(url.pathname)) {
      return route.abort();
    }
    return route.continue();
  });
  const statusResponse = page.waitForResponse(response =>
    response.url() === `${base}/api/v1/status` && response.status() === 200);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const status = await (await statusResponse).json();
  assert.equal(status.api.status, 'healthy');
  assert.match(await page.title(), /FireWatch/i);
  const chat = await page.evaluate(async () => {
    const response = await fetch('/api/v1/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    return response.status;
  });
  assert.equal(chat, 403);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', runtime_arch: status.runtime_arch,
    browser: 'Chromium', ui_api_responses: api, page_errors: errors,
    providers: 'external requests and on-demand weather blocked' }));
} finally {
  await browser.close();
}
