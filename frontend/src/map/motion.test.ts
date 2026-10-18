import { describe, expect, it, vi } from 'vitest';
import { RiskAnimator } from './riskAnimator';
import { clusterGroups } from './markers';
import { miniSparkline } from './interactions';
import type { FireGroup } from '../types';

vi.mock('maplibre-gl', () => ({ Marker: class {} }));

describe('RiskAnimator', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('writes only cells whose quantised value changes', () => {
    const writes: [string | number, number][] = [];
    const anim = new RiskAnimator((id, st) => writes.push([id, st.s]));
    anim.setCells(ids);
    anim.show(Float32Array.from([0.1, 0.5, NaN, 0.9]));
    expect(writes).toHaveLength(3); // the NaN cell stays transparent
    writes.length = 0;
    anim.show(Float32Array.from([0.1, 0.5001, NaN, 0.7]));
    expect(writes).toEqual([['d', expect.closeTo(0.7, 3)]]);
  });

  it('holds the previous colour (dimmed) while a value is loading, then releases it', () => {
    const states = new Map<string | number, { s: number; a: number }>();
    const anim = new RiskAnimator((id, st) => states.set(id, st));
    anim.setCells(ids);
    anim.show(Float32Array.from([0.3, 0.6, 0.2, 0.8]));
    anim.show(Float32Array.from([NaN, 0.6, NaN, 0.8]), { hold: true });
    expect(states.get('a')).toEqual({ s: expect.closeTo(0.3, 3), a: expect.any(Number) });
    expect(states.get('a')!.a).toBeLessThan(1);
    expect(anim.heldCount()).toBe(2);
    anim.releaseHeld();
    expect(states.get('a')!.s).toBe(-1);
    expect(anim.heldCount()).toBe(0);
  });

  it('keeps state when backend tiles append cells', () => {
    const anim = new RiskAnimator(() => undefined);
    anim.setCells(['a', 'b']);
    anim.show(Float32Array.from([0.4, 0.5]));
    expect(anim.setCells(['a', 'b', 'c'], { preserve: true })).toBe(true);
    expect(anim.valueAt(1)).toBeCloseTo(0.5, 3);
    expect(anim.valueAt(2)).toBe(-1);
    expect(anim.setCells(['x', 'b', 'c'], { preserve: true })).toBe(false);
    expect(anim.valueAt(1)).toBe(-1);
  });
});

describe('flame clusters', () => {
  const g = (id: string, lon: number, lat: number, count: number): FireGroup => ({
    id,
    center: [lon, lat],
    bbox: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01],
    count,
    maxFrp: 10,
    sumFrp: 10 * count,
    latest: 0,
    earliest: 0,
    incidentId: null,
    detectionIds: [],
  });
  const groups = [g('big', -121, 39, 50), g('near', -121.05, 39.02, 5), g('far', -118, 34, 8)];

  it('merges nearby fires at state zoom and splits them when zoomed in', () => {
    const state = clusterGroups(groups, 5);
    expect(state).toHaveLength(2);
    const merged = state.find((c) => c.id === 'big')!;
    expect(merged.count).toBe(55);
    expect(merged.groups.map((x) => x.id)).toEqual(['big', 'near']);
    const close = clusterGroups(groups, 11);
    expect(close).toHaveLength(3);
    // The dominant fire keeps its id (and marker) across zoom levels.
    expect(close.some((c) => c.id === 'big')).toBe(true);
  });
});

describe('tooltip sparkline', () => {
  it('draws gaps for missing hours and nothing without data', () => {
    expect(miniSparkline([NaN, NaN], 0)).toBe('');
    const svg = miniSparkline([0.2, 0.4, NaN, 0.6, 0.5], 1);
    expect(svg).toContain('<svg');
    expect((svg.match(/M/g) ?? []).length).toBe(2);
  });
});
