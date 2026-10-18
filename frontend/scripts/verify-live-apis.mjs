/** Opt-in PAID browser verification. Two submissions (three in acceptance mode, one of
 * them an unpaid reference answer); no mocked API responses. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

assert.equal(process.env.FIREWATCH_RUN_PAID_VERIFICATION, '1', 'Explicit paid-test opt-in required');
const api = process.env.FIREWATCH_VERIFY_API ?? 'http://127.0.0.1:8007/api/v1';
assert.equal(new URL(api).hostname, '127.0.0.1', 'Local verification only');
const ui = process.env.FIREWATCH_VERIFY_UI ?? 'http://127.0.0.1:5178/';
const session = process.env.FIREWATCH_VERIFY_SESSION ?? 'firewatch-live-api-results';
assert.equal(path.basename(session), session);
assert.ok(session.startsWith('firewatch-'));
const output = path.join(os.tmpdir(), session);
const acceptance = process.env.FIREWATCH_VERIFY_CHAT_ACCEPTANCE === '1';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const result = { steps: [], answers: [], errors: [], requests: [], apiResponses: [] };
page.on('pageerror', error => result.errors.push(error.message));
page.on('request', request => {
  assert.notEqual(new URL(request.url()).hostname, 'api.openai.com', 'Browser must not contact OpenAI');
  if (request.url().endsWith('/chat')) result.requests.push(request.postDataJSON());
});
page.on('response', response => {
  if (response.url().startsWith(api)) result.apiResponses.push({ path: response.url().slice(api.length), status: response.status() });
});
const state = () => page.evaluate(async () => {
  const { getState, validTimeOf } = await import('/src/state/store.ts');
  const s = getState();
  return { fires: s.fires, messages: s.chat.messages, pending: s.chat.pending,
    location: s.highlight?.place.id, hour: new Date(validTimeOf(s)).toISOString() };
});
async function waitState(predicate, timeout = 100_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await state();
    if (predicate(value)) return value;
    await page.waitForTimeout(100);
  }
  throw new Error('Application state did not reach expected condition');
}
async function select(query, id) {
  await page.getByRole('combobox').fill(query);
  await page.getByRole('option').filter({ hasText: query }).first().click();
  await waitState(s => s.location === id);
}
async function ask(message, model = 'gpt-5-mini') {
  const count = (await state()).messages.length;
  await page.getByRole('textbox', { name: 'Message FireWatch AI' }).fill(message);
  const response = page.waitForResponse(r => r.url() === `${api}/chat`);
  await page.getByRole('textbox', { name: 'Message FireWatch AI' }).press('Enter');
  await response;
  const s = await waitState(s => !s.pending && s.messages.length >= count + 2);
  const answer = s.messages.at(-1);
  result.answers.push({ prompt: message, answer });
  assert.equal(answer.mode, 'api');
  assert.equal(answer.model, model);
  return answer;
}
try {
  await page.goto(`${ui}?api=${encodeURIComponent(api)}`, { waitUntil: 'domcontentloaded' });
  const s = await waitState(s => s.fires.origin === 'api' && s.fires.data?.detections.length > 0);
  await page.waitForFunction(() => window.__fwMap?.getLayer('fw-hotspot') &&
    window.__fwMap.queryRenderedFeatures({ layers: ['fw-hotspot'] }).length > 0);
  const rendered = await page.evaluate(() => window.__fwMap.queryRenderedFeatures({ layers: ['fw-hotspot'] }).length);
  result.steps.push({ check: 'Real FIRMS records rendered by MapLibre', status: 'PASS', records: s.fires.data.detections.length, rendered });
  const detection = s.fires.data.detections[0];
  // Select an actual backend record through the existing UI store to inspect its panel.
  await page.evaluate(async id => { const { select } = await import('/src/state/store.ts'); select({ kind: 'hotspot', detectionId: id }); }, detection.id);
  await page.getByText('Acquired (UTC)', { exact: true }).waitFor();
  const content = await page.locator('.panel').innerText();
  assert.ok(content.includes(detection.acquired_at.slice(0, 10)) && content.includes('Confidence'));
  await page.screenshot({ path: path.join(output, 'real-firms-desktop.png') });
  result.steps.push({ check: 'Real hotspot panel timestamp/confidence/FRP', status: 'PASS', acquired_at: detection.acquired_at, confidence: detection.confidence });
  await page.getByRole('button', { name: 'Close details' }).click();
  // Open before selecting a location to avoid the panel's auto-submitting contextual action.
  await page.getByRole('button', { name: 'Ask FireWatch AI', exact: true }).click();
  await select('Stockton', 'place-ca-stockton');
  const weather = await ask(acceptance
    ? 'Why does FireWatch predict elevated wildfire risk for this location?'
    : "What's the current weather in Stockton, California?", acceptance ? null : 'gpt-5-mini');
  assert.ok(weather.sources.some(s => s.provider === (acceptance ? 'FireWatch' : 'Open-Meteo') && s.scope.includes('Stockton')));
  if (acceptance) {
    assert.match(weather.content, /predictions are unavailable/);
    assert.match(weather.content, /SHAP explanations are also unavailable/);
    assert.ok(weather.suggested_questions.every(q => !/refresh|radius|imagery|SHAP/i.test(q)));
  }
  assert.equal(result.requests.at(-1).location_id, 'place-ca-stockton');
  await page.screenshot({ path: path.join(output, 'real-chat-stockton.png') });
  result.steps.push({ check: acceptance ? 'Validated unavailable Stockton ML/SHAP, safe suggestions, no OpenAI generation' : 'Real OpenAI + real Stockton weather, loading and sources', status: 'PASS' });
  if (acceptance) {
    // Official FIRMS reference definition: no OpenAI call, clickable NASA citation.
    const frp = await ask('What does fire radiative power mean?', null);
    assert.match(frp.content, /megawatts \(MW\)/);
    assert.ok(frp.sources.some(s => s.kind === 'reference' && s.url.startsWith('https://firms.modaps.eosdis.nasa.gov/')));
    await page.locator('.msg--assistant').last().locator('a[href^="https://firms.modaps.eosdis.nasa.gov/"]').first().waitFor();
    await page.locator('.msg--assistant').last().getByText('Sources (').click();
    await page.locator('.msg--assistant').last().getByText('Official reference').first().waitFor();
    await page.screenshot({ path: path.join(output, 'real-chat-reference.png') });
    result.steps.push({ check: 'FRP official reference answer, rendered NASA links, no OpenAI generation', status: 'PASS' });
  }
  await select('Sacramento', 'place-ca-sacramento');
  const detections = await ask('What are the latest fire detections near Sacramento?');
  assert.ok(detections.sources.some(s => s.provider === 'NASA FIRMS' && s.scope.includes('Sacramento')));
  assert.equal(result.requests.at(-1).location_id, 'place-ca-sacramento');
  const last = await state();
  assert.equal(result.requests.at(-1).selected_hour, last.hour.replace('.000Z', 'Z'));
  result.steps.push({ check: 'Real Sacramento detections, current location/hour context', status: 'PASS' });
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await page.getByRole('dialog', { name: 'FireWatch AI assistant' }).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 391);
  await page.screenshot({ path: path.join(output, 'real-chat-mobile.png') });
  result.steps.push({ check: 'Mobile layout', status: 'PASS' });
  assert.equal(result.requests.length, acceptance ? 3 : 2);
  assert.deepEqual(result.errors, []);
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL'; result.error = error.message;
  await page.screenshot({ path: path.join(output, 'real-browser-failure.png') }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'browser.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await browser.close();
}
