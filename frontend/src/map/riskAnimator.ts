/**
 * Drives the per-cell risk feature-state (`s` = score, `a` = alpha factor) on the map.
 *
 * - Hour changes morph colours from the old score to the new one instead of swapping in one frame.
 * - Only cells whose (quantised) value actually changes are written, so an hour change costs a
 *   fraction of the old "write every cell" loop; very large changes fall back to an instant write.
 * - Cells that appear (tile arrives) fade in; cells that vanish fade out.
 * - Optional hold: while the next hour is still loading, keep the previous colour (dimmed) instead
 *   of blanking the area. Held cells are released after `holdMs` so stale colours never linger.
 *
 * The animator is map-agnostic: it receives a `write(id, state)` callback, which keeps it testable.
 */
import { easeInOutCubic, motionOn } from './motion';

export type CellState = { s: number; a: number };
type Write = (id: string | number, state: CellState) => void;

/** Visual quantum: differences below this are invisible on the colour ramp. */
export const QUANTUM = 1 / 250;
const quantize = (v: number) => Math.round(v / QUANTUM) * QUANTUM;
const MISSING = -1;
/** Above this many changed cells per frame, skip the morph and write once. */
const MAX_ANIMATED_CHANGES = 9000;
const HELD_ALPHA = 0.45;

const raf = (fn: FrameRequestCallback) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : (setTimeout(() => fn(Date.now()), 16) as unknown as number));
const caf = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface ShowOptions {
  duration?: number;
  /** Keep showing the previous value (dimmed) for cells whose new value isn't loaded yet. */
  hold?: boolean;
  /** Release held cells after this long (ms). */
  holdMs?: number;
}

export class RiskAnimator {
  private ids: (string | number)[] = [];
  /** Score currently written to the map (MISSING = transparent). */
  private shownS = new Float32Array(0);
  /** Alpha factor currently written to the map. */
  private shownA = new Float32Array(0);
  private held = new Uint8Array(0);
  private frame = 0;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** Number of feature-state writes performed (for tests and the perf overlay). */
  writes = 0;
  /** True while a morph is in progress. */
  animating = false;

  constructor(private readonly write: Write) {}

  /** New cell list. Keeps state for cells whose index/id is unchanged (backend tiles append). */
  setCells(ids: (string | number)[], { preserve = false }: { preserve?: boolean } = {}) {
    const keep = preserve && ids.length >= this.ids.length && this.ids.every((id, i) => ids[i] === id);
    const n = ids.length;
    const s = new Float32Array(n).fill(MISSING);
    const a = new Float32Array(n).fill(1);
    const h = new Uint8Array(n);
    if (keep) {
      s.set(this.shownS);
      a.set(this.shownA);
      h.set(this.held);
    }
    this.cancel();
    this.ids = ids.slice();
    this.shownS = s;
    this.shownA = a;
    this.held = h;
    return keep;
  }

  get size() {
    return this.ids.length;
  }

  /** Displayed score for a cell index (MISSING when transparent). */
  valueAt(i: number) {
    return this.shownS[i];
  }

  cancel() {
    if (this.frame) caf(this.frame);
    this.frame = 0;
    this.animating = false;
  }

  private put(i: number, s: number, a: number) {
    if (this.shownS[i] === s && this.shownA[i] === a) return;
    this.shownS[i] = s;
    this.shownA[i] = a;
    this.writes++;
    this.write(this.ids[i], { s, a });
  }

  /** Show `values` (aligned with the cell list; NaN = not available). */
  show(values: ArrayLike<number>, { duration = 0, hold = false, holdMs = 4000 }: ShowOptions = {}) {
    this.cancel();
    const n = this.ids.length;
    const target = new Float32Array(n);
    const targetA = new Float32Array(n).fill(1);
    let changed = 0;
    let anyHeld = false;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      let t = Number.isFinite(v) && v >= 0 ? quantize(v) : MISSING;
      if (t === MISSING && hold && this.shownS[i] >= 0) {
        // Keep the previous colour, dimmed, until this hour's value arrives.
        t = this.shownS[i];
        targetA[i] = HELD_ALPHA;
        this.held[i] = 1;
        anyHeld = true;
      } else this.held[i] = 0;
      target[i] = t;
      if (t !== this.shownS[i] || targetA[i] !== this.shownA[i]) changed++;
    }
    clearTimeout(this.holdTimer);
    if (anyHeld) this.holdTimer = setTimeout(() => this.releaseHeld(), holdMs);
    if (!changed) return;

    if (duration <= 0 || !motionOn() || changed > MAX_ANIMATED_CHANGES) {
      for (let i = 0; i < n; i++) this.put(i, target[i], target[i] === MISSING ? 1 : targetA[i]);
      return;
    }

    const fromS = this.shownS.slice();
    const fromA = this.shownA.slice();
    // Only cells that change take part in the morph.
    const moving: number[] = [];
    for (let i = 0; i < n; i++) if (target[i] !== fromS[i] || targetA[i] !== fromA[i]) moving.push(i);
    const start = now();
    this.animating = true;
    const step = () => {
      const raw = Math.min(1, (now() - start) / duration);
      const k = easeInOutCubic(raw);
      for (const i of moving) {
        const f = fromS[i], t = target[i];
        if (f === MISSING && t !== MISSING) {
          // Appear: final colour, fading in.
          this.put(i, t, quantize(targetA[i] * k));
        } else if (t === MISSING && f !== MISSING) {
          // Disappear: fade out, then clear.
          if (raw >= 1) this.put(i, MISSING, 1);
          else this.put(i, f, quantize(fromA[i] * (1 - k)));
        } else {
          this.put(i, raw >= 1 ? t : quantize(f + (t - f) * k), raw >= 1 ? targetA[i] : quantize(fromA[i] + (targetA[i] - fromA[i]) * k));
        }
      }
      if (raw < 1) this.frame = raf(step);
      else {
        this.frame = 0;
        this.animating = false;
      }
    };
    this.frame = raf(step);
  }

  /** Held cells whose value never arrived become transparent. */
  releaseHeld() {
    for (let i = 0; i < this.ids.length; i++)
      if (this.held[i]) {
        this.held[i] = 0;
        this.put(i, MISSING, 1);
      }
  }

  heldCount() {
    let c = 0;
    for (let i = 0; i < this.held.length; i++) c += this.held[i];
    return c;
  }
}
