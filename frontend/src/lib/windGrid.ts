/**
 * Wind helpers: a geographic arrow lattice for city zoom (arrows stay pinned to the ground while
 * panning, instead of being re-laid on a screen grid after the map stops), and vector blending of
 * two wind fields for smooth playback.
 */
import type { LngLat } from './geo';

const RAD = Math.PI / 180;

/** Degrees of longitude per screen pixel at a zoom level (512 px MapLibre tiles). */
export const degPerPixel = (zoom: number) => 360 / (512 * 2 ** zoom);

export interface Lattice {
  points: LngLat[];
  /** Area the points cover (viewport plus margin): recompute only when the view leaves it. */
  covers: [number, number, number, number];
  zoomBucket: number;
}

/**
 * Staggered lattice anchored to global multiples of the spacing, so the same geographic points are
 * produced for overlapping views. Spacing ≈ `px` screen pixels at the bucketed zoom.
 */
export function lattice(view: [number, number, number, number], zoom: number, px = 96, margin = 0.35, maxPoints = 900): Lattice {
  const zoomBucket = Math.floor(zoom * 2) / 2;
  const [w0, s0, e0, n0] = view;
  const mx = (e0 - w0) * margin, my = (n0 - s0) * margin;
  const w = w0 - mx, s = s0 - my, e = e0 + mx, n = n0 + my;
  // Whole-degree latitude keeps the spacing (and so the points) identical for overlapping views.
  const lat0 = Math.round((s + n) / 2) * RAD;
  let stepX = px * degPerPixel(zoomBucket);
  let stepY = stepX * Math.cos(lat0);
  // Never flood the map with arrows on very wide screens.
  while (((e - w) / stepX) * ((n - s) / stepY) > maxPoints) {
    stepX *= 1.25;
    stepY *= 1.25;
  }
  const points: LngLat[] = [];
  const j0 = Math.floor(s / stepY), j1 = Math.ceil(n / stepY);
  for (let j = j0; j <= j1; j++) {
    const offset = j % 2 ? stepX / 2 : 0;
    const i0 = Math.floor((w - offset) / stepX), i1 = Math.ceil((e - offset) / stepX);
    for (let i = i0; i <= i1; i++) points.push([+(i * stepX + offset).toFixed(5), +(j * stepY).toFixed(5)]);
  }
  return { points, covers: [w, s, e, n], zoomBucket };
}

/** True when `view` is still inside the lattice's coverage at the same zoom bucket. */
export const latticeValid = (l: Lattice | null, view: [number, number, number, number], zoom: number) =>
  !!l && l.zoomBucket === Math.floor(zoom * 2) / 2 && view[0] >= l.covers[0] && view[1] >= l.covers[1] && view[2] <= l.covers[2] && view[3] <= l.covers[3];

/**
 * Blend two winds given as speed + meteorological FROM direction, interpolating the flow vectors
 * (so a 350° → 10° change turns through north, and opposing winds pass through calm).
 */
export function blendWind(speedA: number, fromA: number, speedB: number, fromB: number, k: number): { speed: number; from: number } {
  const ua = -speedA * Math.sin(fromA * RAD), va = -speedA * Math.cos(fromA * RAD);
  const ub = -speedB * Math.sin(fromB * RAD), vb = -speedB * Math.cos(fromB * RAD);
  const u = ua + (ub - ua) * k, v = va + (vb - va) * k;
  const speed = Math.hypot(u, v);
  const from = speed < 1e-6 ? fromB : ((Math.atan2(-u, -v) / RAD) % 360 + 360) % 360;
  return { speed, from };
}
