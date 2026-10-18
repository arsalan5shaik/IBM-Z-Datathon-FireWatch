/**
 * Replay of past satellite detections: hotspots appear in acquisition order over a few seconds,
 * coloured by age relative to the replay clock. The map shows only detections acquired up to the
 * replay time (see applyFires in map/sync.ts); flame markers and influence shapes are hidden.
 */
import { HOUR_MS } from '../lib/time';
import { getState, setState } from './store';

/**
 * Event pacing: playback progress p maps to the time t where
 *   LINEAR·(t − from)/span + (1 − LINEAR)·share_of_detections_by(t) = p,
 * so quiet hours between satellite overpasses pass quickly and bursts of detections unfold.
 */
const LINEAR = 0.3;
let times: number[] = [];
export function timeAtProgress(p: number, from: number, to: number, sorted: number[] = times): number {
  const span = Math.max(1, to - from);
  const n = sorted.length;
  if (!n) return from + span * p;
  const share = (t: number) => {
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo / n;
  };
  let lo = from, hi = to;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (LINEAR * ((mid - from) / span) + (1 - LINEAR) * share(mid) < p) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Wall-clock length of a full replay. */
export const REPLAY_MS = 15_000;
/** Data updates per second while replaying (the map re-draws the hotspot source each step). */
const STEPS_PER_SECOND = 14;

let raf = 0;
let last = 0;
let endTimer: ReturnType<typeof setTimeout> | undefined;

function loop() {
  cancelAnimationFrame(raf);
  last = performance.now();
  let pending = 0;
  const step = (now: number) => {
    const r = getState().replay;
    if (!r || !r.playing) {
      raf = 0;
      return;
    }
    pending += now - last;
    last = now;
    if (pending >= 1000 / STEPS_PER_SECOND) {
      const progress = Math.min(1, r.progress + pending / REPLAY_MS);
      pending = 0;
      if (progress >= 1) {
        setState({ replay: { ...r, at: r.to, progress: 1, playing: false } });
        raf = 0;
        // Linger on the full picture, then return to the live view.
        clearTimeout(endTimer);
        endTimer = setTimeout(() => {
          const cur = getState().replay;
          if (cur && !cur.playing && cur.progress >= 1) stopReplay();
        }, 2500);
        return;
      }
      setState({ replay: { ...r, progress, at: timeAtProgress(progress, r.from, r.to) } });
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

export function startReplay() {
  const s = getState();
  clearTimeout(endTimer);
  const to = s.now;
  const from = to - s.lookbackHours * HOUR_MS;
  times = (s.fires.data?.detections ?? [])
    .map((d) => Date.parse(d.acquired_at))
    .filter((t) => t >= from && t <= to)
    .sort((a, b) => a - b);
  setState({ replay: { from, to, at: from, progress: 0, playing: true }, playing: false, selection: null, layers: { ...s.layers, fires: true } });
  loop();
}

export function toggleReplay() {
  const r = getState().replay;
  if (!r) return startReplay();
  clearTimeout(endTimer);
  if (r.playing) setState({ replay: { ...r, playing: false } });
  else {
    setState({ replay: { ...r, ...(r.progress >= 1 ? { at: r.from, progress: 0 } : {}), playing: true } });
    loop();
  }
}

/** Jump to a fraction (0–1) of the replay window. */
export function seekReplay(frac: number) {
  const r = getState().replay;
  if (!r) return;
  clearTimeout(endTimer);
  const progress = Math.max(0, Math.min(1, frac));
  setState({ replay: { ...r, progress, at: timeAtProgress(progress, r.from, r.to) } });
}

export function stopReplay() {
  cancelAnimationFrame(raf);
  raf = 0;
  clearTimeout(endTimer);
  setState({ replay: null });
}
