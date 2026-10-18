/**
 * Shared motion primitives. Every animation in the map goes through `tween`, which collapses to a
 * single final frame when the OS asks for reduced motion or the user turned smooth motion off.
 */
import { getState } from '../state/store';

/** Durations (ms) — keep in step with the CSS motion tokens in app.css (--dur-*). */
export const MOTION = {
  fast: 140,
  base: 240,
  fade: 280,
  slow: 420,
  camera: 1000,
  flyFar: 1800,
} as const;

export const prefersReducedMotion = () => (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) ?? false;

/** True when animations should run (OS setting and the in-app "Smooth motion" preference). */
export const motionOn = () => !prefersReducedMotion() && getState().smoothMotion;

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOutBack = (t: number) => {
  const c1 = 1.4, c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

const raf = (fn: FrameRequestCallback) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : (setTimeout(() => fn(Date.now()), 16) as unknown as number));
const caf = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

/**
 * Run `onFrame(k)` with k going 0 → 1 over `duration` ms. Returns a cancel function.
 * With motion off (or duration ≤ 0) it calls onFrame(1) synchronously and finishes.
 */
export function tween(
  duration: number,
  onFrame: (k: number, raw: number) => void,
  { easing = easeOutCubic, onDone, force = false }: { easing?: (t: number) => number; onDone?: () => void; force?: boolean } = {},
): () => void {
  if (duration <= 0 || (!force && !motionOn())) {
    onFrame(1, 1);
    onDone?.();
    return () => undefined;
  }
  let id = 0;
  let cancelled = false;
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const step = (now: number) => {
    if (cancelled) return;
    const raw = Math.min(1, (now - start) / duration);
    onFrame(easing(raw), raw);
    if (raw < 1) id = raf(step);
    else onDone?.();
  };
  id = raf(step);
  return () => {
    cancelled = true;
    caf(id);
  };
}

/** Linear interpolation of compass directions along the shortest arc (degrees). */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}
