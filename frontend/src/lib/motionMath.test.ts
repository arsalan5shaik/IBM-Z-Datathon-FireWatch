import { describe, expect, it } from 'vitest';
import { buildWindField, flowVector, sampleField } from './windField';
import { blendWind, lattice, latticeValid } from './windGrid';
import { windLevels } from './windLevels';
import { coarseValues, prepareCoarse, prepareSurface, surfaceFeatures } from './surface';
import { nightFeatures, nightFraction, sunElevation } from './solar';
import { PALETTES } from './palette';
import { lerpAngle } from '../map/motion';

describe('wind flow vectors', () => {
  it('points downwind: wind FROM the west flows east, FROM the north flows south', () => {
    const [ue, ve] = flowVector(10, 270);
    expect(ue).toBeCloseTo(10, 6);
    expect(ve).toBeCloseTo(0, 6);
    const [un, vn] = flowVector(10, 0);
    expect(un).toBeCloseTo(0, 6);
    expect(vn).toBeCloseTo(-10, 6);
    // Santa Ana–style north-easterly (from 45°) flows toward the south-west.
    const [us, vs] = flowVector(20, 45);
    expect(us).toBeLessThan(0);
    expect(vs).toBeLessThan(0);
  });

  it('builds a field that samples the forecast vector and stays empty far from samples', () => {
    const points: [number, number][] = [];
    for (let lon = -124; lon <= -118; lon += 0.5) for (let lat = 34; lat <= 40; lat += 0.5) points.push([lon, lat]);
    const speed = Float32Array.from(points, () => 18);
    const from = Float32Array.from(points, () => 315); // north-westerly
    const f = buildWindField(points, speed, from);
    const out: [number, number] = [0, 0];
    expect(sampleField(f, -121.2, 37.3, out)).toBe(true);
    expect(out[0]).toBeGreaterThan(0); // toward the east
    expect(out[1]).toBeLessThan(0); // toward the south
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(18, 0);
    // Far outside the sample lattice there is no data.
    expect(sampleField(f, -114.2, 42.5, out)).toBe(false);
  });
});

describe('wind blending and lattice', () => {
  it('blends through the shortest turn and keeps endpoints exact', () => {
    expect(blendWind(10, 350, 10, 10, 0).from).toBeCloseTo(350, 4);
    expect(blendWind(10, 350, 10, 10, 1).from).toBeCloseTo(10, 4);
    const mid = blendWind(10, 350, 10, 10, 0.5);
    expect(Math.min(mid.from, 360 - mid.from)).toBeLessThan(1);
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0, 6);
  });

  it('produces a ground-anchored lattice that is stable across overlapping views', () => {
    const a = lattice([-122.6, 37.6, -122.2, 37.9], 10);
    const b = lattice([-122.55, 37.62, -122.15, 37.92], 10);
    const keys = new Set(a.points.map((p) => p.join(',')));
    const shared = b.points.filter((p) => keys.has(p.join(','))).length;
    expect(shared / b.points.length).toBeGreaterThan(0.8);
    expect(latticeValid(a, [-122.55, 37.62, -122.25, 37.88], 10.2)).toBe(true);
    expect(latticeValid(a, [-121, 37.62, -120.5, 37.88], 10)).toBe(false);
  });

  it('thins wind points into nested density levels', () => {
    const pts: [number, number][] = [];
    for (let lon = -124; lon <= -114; lon += 0.25) for (let lat = 32.5; lat <= 42; lat += 0.25) pts.push([lon, lat]);
    const lv = windLevels(pts);
    const count = (l: number) => Array.from(lv).filter((v) => v <= l).length;
    expect(count(0)).toBeGreaterThan(0);
    expect(count(0)).toBeLessThan(count(1));
    expect(count(1)).toBeLessThan(count(2));
    expect(count(2)).toBe(pts.length);
  });
});

describe('statewide level of detail', () => {
  const centers = new Float32Array(
    Array.from({ length: 40 * 40 }, (_, k) => [-123 + (k % 40) * 0.12, 36 + Math.floor(k / 40) * 0.1]).flat(),
  );
  it('surface bands match the cell colours and only cover the grid', () => {
    const prep = prepareSurface(centers);
    const values = new Float32Array(1600).map((_, k) => ((k % 40) / 39) * 0.95);
    const bands = surfaceFeatures(prep, values, PALETTES.default);
    expect(bands.length).toBeGreaterThan(3);
    expect(bands.map((b) => b.properties.v)).toEqual([...bands.map((b) => b.properties.v)].sort((a, b) => a - b));
    for (const b of bands) expect(b.properties.fill).toMatch(/^rgba\(/);
    const xs = bands.flatMap((b) => b.geometry.coordinates.flat(2).map((p) => p[0]));
    expect(Math.min(...xs)).toBeGreaterThan(-124);
    expect(Math.max(...xs)).toBeLessThan(-117.5);
  });

  it('coarse hexes keep the maximum member score', () => {
    const prep = prepareCoarse(centers, 42);
    expect(prep.features.length).toBeGreaterThan(4);
    expect(prep.features.length).toBeLessThan(1600 / 4);
    const values = new Float32Array(1600).fill(0.1);
    values[123] = 0.9;
    const out = coarseValues(prep, values);
    expect(out[prep.member[123]]).toBeCloseTo(0.9, 5);
    expect(Math.max(...Array.from(out))).toBeCloseTo(0.9, 5);
  });
});

describe('solar', () => {
  it('knows day from night in California', () => {
    // Sacramento, 2026-06-21 20:00 UTC (1 PM PDT) is day; 10:00 UTC (3 AM PDT) is night.
    expect(sunElevation(-121.5, 38.6, Date.UTC(2026, 5, 21, 20))).toBeGreaterThan(60);
    expect(sunElevation(-121.5, 38.6, Date.UTC(2026, 5, 21, 10))).toBeLessThan(-15);
    expect(nightFraction(-121.5, 38.6, Date.UTC(2026, 5, 21, 10))).toBe(1);
    expect(nightFraction(-121.5, 38.6, Date.UTC(2026, 5, 21, 20))).toBe(0);
  });
  it('traces nested night bands', () => {
    const fc = nightFeatures(Date.UTC(2026, 9, 18, 3));
    expect(fc.length).toBeGreaterThan(0);
    expect(fc.every((f) => f.geometry.coordinates.length > 0)).toBe(true);
  });
});
