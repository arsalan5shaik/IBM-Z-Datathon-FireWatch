import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SampleProvider } from './sampleProvider';
import { RISK_LEVELS } from '../config';
import { riskLevelKey } from '../lib/risk';

// Serve /data/* from public/ so the provider can "fetch" its static grid.
beforeAll(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = resolve(import.meta.dirname, '../../public', String(url).replace(/^\.?\//, ''));
    const body = readFileSync(path, 'utf8');
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
});

describe('SampleProvider', () => {
  const provider = new SampleProvider(Date.parse('2026-10-17T17:20:00Z'));

  it('produces an hourly 7-day risk grid with scores in [0,1]', async () => {
    const risk = await provider.getRisk();
    const n = risk.cells.length;
    expect(risk.metadata.frames).toBe(168);
    expect(risk.metadata.step_minutes).toBe(60);
    expect(risk.scores.length).toBe(168 * n);
    let min = 1, max = 0;
    for (const s of risk.scores) {
      min = Math.min(min, s);
      max = Math.max(max, s);
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);

    // Distribution report (helps tune the demo so most of the state is not shaded).
    const levels = Object.fromEntries(RISK_LEVELS.map((l) => [l.key, 0]));
    for (const s of risk.scores) levels[riskLevelKey(s)]++;
    const pct = Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, ((v / risk.scores.length) * 100).toFixed(1) + '%']));
    const daily = Array.from({ length: 7 }, (_, d) => {
      let m = 0, shaded = 0;
      for (let f = d * 24; f < d * 24 + 24; f++)
        for (let i = 0; i < n; i++) {
          const s = risk.scores[f * n + i];
          m = Math.max(m, s);
          if (s >= 0.4) shaded++;
        }
      return `d${d}: max ${m.toFixed(2)} high+ ${((shaded / (24 * n)) * 100).toFixed(1)}%`;
    });
    console.log('levels', pct, '\n' + daily.join('\n'));
    expect(levels.low).toBeGreaterThan(risk.scores.length * 0.4);
  });

  it('explanations sum to the raw margin and match the map score', async () => {
    const risk = await provider.getRisk();
    const start = Date.parse(risk.metadata.forecast_start);
    for (const [cellIdx, frame] of [[10, 0], [1500, 50], [3000, 120]]) {
      const cell = risk.cells[cellIdx].properties.cell_id;
      const ex = await provider.explain(cell, start + frame * 3600_000);
      const sum = ex.base_value + ex.drivers.reduce((s, d) => s + d.contribution_raw, 0);
      expect(sum).toBeCloseTo(ex.raw_score, 1);
      expect(ex.risk_score).toBeCloseTo(risk.scores[frame * risk.cells.length + cellIdx], 4);
    }
  });

  it('weather grid covers CA and the ocean', async () => {
    const w = await provider.getWeather();
    expect(w.points.length).toBeGreaterThan(800);
    expect(w.wind_speed_kmh.length).toBe(168 * w.points.length);
    const maxWind = w.wind_speed_kmh.reduce((a, b) => Math.max(a, b), 0);
    console.log('weather points', w.points.length, 'max wind', maxWind.toFixed(0));
  });

  it('fires have detections, incidents and perimeters', async () => {
    const f = await provider.getFires(48);
    const inc = await provider.getIncidents();
    console.log('detections', f.detections.length, 'incidents', inc.incidents.map((i) => `${i.name}: ${i.acres ?? '–'} ac`).join(', '));
    expect(f.detections.length).toBeGreaterThan(100);
    expect(inc.incidents.some((i) => i.geometry)).toBe(true);
  });
});
