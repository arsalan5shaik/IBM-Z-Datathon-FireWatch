/** Chrome integration: real FastAPI/location/weather, explicitly labeled model stub. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ui = process.env.FIREWATCH_CHAT_UI ?? 'http://127.0.0.1:5177/';
const realApi = process.env.FIREWATCH_CHAT_REAL_API ?? 'http://127.0.0.1:8003/api/v1';
const mockModelApi = process.env.FIREWATCH_CHAT_TEST_API ?? 'http://127.0.0.1:8004/api/v1';
const output = process.env.FIREWATCH_CHAT_OUTPUT ?? path.join(os.tmpdir(), 'firewatch-chat-verification');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const results = { real_openai: 'BLOCKED: no configured key', hosted_research: 'BLOCKED: no configured key', steps: [], chatRequests: [], errors: [] };
page.on('pageerror', e => results.errors.push(e.message));
page.on('request', request => {
  if (request.url().endsWith('/chat')) results.chatRequests.push({ url: request.url(), body: request.postDataJSON() });
});
const store = async () => page.evaluate(async () => {
  const { getState, validTimeOf } = await import('/src/state/store.ts');
  const s = getState();
  return { messages: s.chat.messages, context: s.chat.context, pending: s.chat.pending,
    location: s.highlight?.place.id, hour: new Date(validTimeOf(s)).toISOString() };
});
async function select(query, id) {
  await page.getByRole('combobox').fill(query);
  await page.getByRole('option').filter({ hasText: query }).first().click();
  await page.waitForFunction(async expected => (await import('/src/state/store.ts')).getState().highlight?.place.id === expected, id);
}
async function ask(text) {
  const before = (await store()).messages.length;
  await page.getByRole('textbox', { name: 'Message FireWatch AI' }).fill(text);
  await page.getByRole('textbox', { name: 'Message FireWatch AI' }).press('Enter');
  await page.waitForFunction(async old => {
    const s = (await import('/src/state/store.ts')).getState();
    return !s.chat.pending && s.chat.messages.length > old + 1;
  }, before, { timeout: 90_000 });
  return (await store()).messages.at(-1);
}
try {
  await page.goto(`${ui}?api=${encodeURIComponent(realApi)}`, { waitUntil: 'domcontentloaded' });
  await select('Stockton', 'place-ca-stockton');
  await page.getByRole('button', { name: 'Ask FireWatch AI', exact: true }).click();
  assert.match((await ask('What is the weather tomorrow?')).content, /OPENAI_API_KEY/);
  assert.equal((await store()).messages.at(-1).mode, 'error');
  await page.getByRole('button', { name: 'Retry message', exact: true }).click();
  await page.waitForFunction(async () => !(await import('/src/state/store.ts')).getState().chat.pending);
  await page.screenshot({ path: path.join(output, 'key-missing-desktop.png') });
  results.steps.push({ name: 'Real backend: missing-key error and retry, no sample fallback', status: 'PASS' });
  const refused = await ask('Who won the Super Bowl?');
  assert.match(refused.content, /California wildfire/);
  results.steps.push({ name: 'Real backend: unrelated sports refusal without OpenAI', status: 'PASS' });

  await page.goto(`${ui}?api=${encodeURIComponent(mockModelApi)}`, { waitUntil: 'domcontentloaded' });
  await select('Stockton', 'place-ca-stockton');
  await page.getByRole('button', { name: 'Ask FireWatch AI', exact: true }).click();
  const weather = await ask('What is the weather tomorrow?');
  assert.equal(weather.mode, 'api'); assert.match(weather.model, /MOCK/);
  assert.ok(weather.sources.some(source => source.provider === 'Open-Meteo'));
  assert.ok(results.chatRequests.at(-1).body.location_id === 'place-ca-stockton');
  await page.getByText('Sources (1)', { exact: true }).last().click();
  assert.match(await page.getByRole('dialog', { name: 'FireWatch AI assistant' }).innerText(), /Coarse|Open-Meteo/);
  await page.screenshot({ path: path.join(output, 'stockton-real-weather-mock-model.png') });
  results.steps.push({ name: 'Model stub + real provider: Stockton tomorrow weather, sources and timestamps', status: 'PASS' });

  // Keep the chat open and select Sacramento through the normal map search.
  await select('Sacramento', 'place-ca-sacramento');
  const before = (await store()).hour;
  const wind = await ask('What are the wind conditions?');
  assert.ok(wind.sources.some(source => source.provider === 'Open-Meteo' && source.scope.includes('Sacramento')));
  assert.equal(results.chatRequests.at(-1).body.location_id, 'place-ca-sacramento');
  assert.equal(results.chatRequests.at(-1).body.selected_hour, before.replace('.000Z', 'Z'));
  results.steps.push({ name: 'Model stub + real provider: Sacramento wind, current selected hour/context', status: 'PASS' });

  const keyboard = page.getByRole('textbox', { name: 'Message FireWatch AI' });
  await keyboard.fill('Wildfire'); await keyboard.press('Shift+Enter');
  assert.match(await keyboard.inputValue(), /\n/); await keyboard.fill('');
  assert.equal((await ask('Explain seven-day wildfire risk and SHAP')).mode, 'api');
  const noMl = (await store()).messages.at(-1);
  assert.match(noMl.content, /unavailable/); assert.ok(noMl.limitations.length);
  results.steps.push({ name: 'Missing ML/SHAP explicit; Shift+Enter newline', status: 'PASS' });
  assert.match((await ask('Recent satellite detections near Sacramento')).content, /unavailable/);
  results.steps.push({ name: 'Unavailable FIRMS cache stays explicit', status: 'PASS' });
  assert.match((await ask('What caused the Camp Fire?')).content, /cannot verify/);
  results.steps.push({ name: 'Unavailable hosted research never becomes invented history/citations', status: 'PASS' });
  assert.equal((await ask('simulate timeout wildfire weather')).mode, 'error');
  assert.equal((await ask('simulate rate limit wildfire weather')).mode, 'error');
  results.steps.push({ name: 'Simulated OpenAI timeout/rate limit: explicit recoverable UI errors', status: 'PASS' });

  await context.setOffline(true);
  assert.equal((await ask('Wildfire weather')).mode, 'error');
  await context.setOffline(false);
  assert.equal((await ask('Wildfire weather')).mode, 'api');
  results.steps.push({ name: 'Browser backend outage and recovery', status: 'PASS' });
  await page.getByRole('button', { name: 'Start a new conversation' }).click();
  assert.equal((await store()).messages.length, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await page.getByRole('dialog', { name: 'FireWatch AI assistant' }).boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 391);
  await page.screenshot({ path: path.join(output, 'mobile-chat.png') });
  await page.getByRole('button', { name: 'Close assistant' }).click();
  await page.getByRole('button', { name: 'Ask FireWatch AI', exact: true }).waitFor();
  results.steps.push({ name: 'Clear, mobile layout, accessible close/reopen', status: 'PASS' });
  assert.equal(results.errors.length, 0);
  results.status = 'PASS';
} catch (error) {
  results.status = 'FAIL'; results.error = error.stack;
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ status: results.status, real_openai: results.real_openai, hosted_research: results.hosted_research, steps: results.steps, errors: results.errors, output }));
  await browser.close();
}
