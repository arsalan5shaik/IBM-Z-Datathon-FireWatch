import { distanceKm, type LngLat } from './geo';

/** Thin wind points into 3 density levels (≈100 km, ≈50 km, all): 0 = shown at every zoom. */
export function windLevels(points: LngLat[]): Uint8Array {
  const lv = new Uint8Array(points.length).fill(2);
  for (const [level, km] of [[0, 95], [1, 45]] as const) {
    // Grid-accelerated greedy thinning (the old all-pairs scan was O(n²)).
    const cell = km / 111;
    const kept = new Map<string, LngLat[]>();
    points.forEach((p, i) => {
      if (lv[i] < level) return;
      const gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (const k of kept.get(`${gx + dx}:${gy + dy}`) ?? []) if (distanceKm(k, p) < km * 0.98) return;
      const key = `${gx}:${gy}`;
      (kept.get(key) ?? kept.set(key, []).get(key)!).push(p);
      lv[i] = Math.min(lv[i], level);
    });
  }
  return lv;
}
