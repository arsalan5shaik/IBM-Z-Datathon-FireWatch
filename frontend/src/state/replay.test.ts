import { describe, expect, it } from 'vitest';
import { timeAtProgress } from './replay';

describe('event-paced replay', () => {
  const H = 3_600_000;
  const from = 0, to = 24 * H;
  // Two overpass bursts: 50 detections around 9 h and 50 around 21 h.
  const times = [...Array.from({ length: 50 }, (_, i) => 9 * H + i * 60_000), ...Array.from({ length: 50 }, (_, i) => 21 * H + i * 60_000)].sort((a, b) => a - b);

  it('is monotonic and spans the window', () => {
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const t = timeAtProgress(Math.min(1, p), from, to, times);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    expect(timeAtProgress(0, from, to, times)).toBeLessThan(H);
    expect(timeAtProgress(1, from, to, times)).toBeGreaterThan(23 * H);
  });

  it('crosses quiet hours quickly and slows down through bursts', () => {
    // Reaching the first burst takes far less than its linear share (9/24 = 37.5 %).
    const pAtBurst = (() => {
      for (let p = 0; p <= 1; p += 0.005) if (timeAtProgress(p, from, to, times) >= 9 * H) return p;
      return 1;
    })();
    expect(pAtBurst).toBeLessThan(0.2);
    // Without detections the replay is linear.
    expect(timeAtProgress(0.5, from, to, [])).toBe(12 * H);
  });
});
