import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { answerOffline } from './assistant';
import { coverageFromGroups, groupDetections } from './fireGroups';
import { sample } from '../state/data';
import { getState, setState, validTimeOf } from '../state/store';
import type { PlaceResult } from '../types';

// Exercise API-mode safeguards independently of the developer/build environment.
vi.mock('../config', async () => ({ ...await vi.importActual('../config'), API_BASE: '/api/v1' }));

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = resolve(import.meta.dirname, '../../public', String(url).replace(/^\.?\//, ''));
    return new Response(readFileSync(path, 'utf8'), { status: 200 });
  });
  const p = sample();
  const [fires, incidents, risk, weather] = await Promise.all([p.getFires(48), p.getIncidents(), p.getRisk(), p.getWeather()]);
  const places = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../public/data/places.json'), 'utf8')) as { results: PlaceResult[] }).results;
  const ds = <T,>(data: T) => ({ state: 'ready' as const, data, origin: 'sample' as const, error: null, at: Date.now() });
  const groups = groupDetections(fires.detections, incidents.incidents);
  setState({
    fires: ds(fires),
    incidents: ds(incidents),
    risk: ds(risk),
    weather: ds(weather),
    places: ds(places),
    derived: { detections: fires.detections, groups, coverage: coverageFromGroups(groups, fires.detections) },
  });
});

const ask = async (q: string, ctx = null as Parameters<typeof answerOffline>[2]) => {
  const s = getState();
  const res = await answerOffline(q, s, ctx, validTimeOf(s));
  console.log(`\nQ: ${q}\nA: ${res.answer}\n   [${res.grounding.map((g) => g.dataset).join(', ')}]`);
  return res.answer;
};

describe('offline assistant with an API configured', () => {
  it('answers place + day questions from the data', async () => {
    const a = await ask('Why is Stockton high risk on Day 4?');
    expect(a).toMatch(/Stockton/);
    expect(a).toMatch(/score/);
  });
  it('lists live fires near a city', async () => {
    const a = await ask('What live fires are near Sacramento?');
    expect(a).toMatch(/hotspot|detection/i);
  });
  it('explains wind for a selected area', async () => {
    const a = await ask('How is wind affecting this area?', { label: 'Area near Paradise · Sat 3 PM', lngLat: [-121.6, 39.76] });
    expect(a).toMatch(/Wind|wind/);
  });
  it('finds the peak hour', async () => {
    const a = await ask('When is the peak risk this week for Redding?');
    expect(a).toMatch(/highest forecast hour/);
  });
  it('handles statewide, glossary, safety and out-of-state questions', async () => {
    expect(await ask('Where is the highest risk right now?')).toMatch(/County/);
    const shap = await ask('What is SHAP?');
    expect(shap).toMatch(/model endpoint.*declared output scale/);
    expect(shap).not.toMatch(/log-odds|percentage points/);
    expect(await ask('Should I evacuate?')).toMatch(/911/);
    expect(await ask('Is Reno at risk?')).toMatch(/only covers California/);
    expect(await ask('what does FRP mean')).toMatch(/radiative/);
    expect(await ask('Tell me about ZIP 95969 tomorrow at 3pm')).toMatch(/95969|Paradise/);
  });
});
