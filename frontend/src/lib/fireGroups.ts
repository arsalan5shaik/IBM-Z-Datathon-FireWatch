import type { CoverageCollection, Detection, FireGroup, Incident } from '../types';
import { outlineAround } from './contour';
import { bboxOfPoints, distanceKm, pointInGeometry, type LngLat } from './geo';
import { parseTime } from './time';

/**
 * Cluster detections that are within `epsKm` of each other (single-linkage, grid-accelerated).
 * Groups are a display convenience (flame markers, influence outlines), not official incidents.
 */
export function groupDetections(dets: Detection[], incidents: Incident[], epsKm = 2.5): FireGroup[] {
  const n = dets.length;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const cellDeg = epsKm / 85; // conservative for California latitudes
  const grid = new Map<string, number[]>();
  dets.forEach((d, i) => {
    const key = `${Math.floor(d.lon / cellDeg)}:${Math.floor(d.lat / cellDeg)}`;
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  });
  dets.forEach((d, i) => {
    const gx = Math.floor(d.lon / cellDeg), gy = Math.floor(d.lat / cellDeg);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
          if (j <= i) continue;
          if (distanceKm([d.lon, d.lat], [dets[j].lon, dets[j].lat]) <= epsKm) parent[find(i)] = find(j);
        }
  });

  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const list = members.get(r);
    if (list) list.push(i);
    else members.set(r, [i]);
  }

  const groups: FireGroup[] = [];
  for (const idx of members.values()) {
    const ds = idx.map((i) => dets[i]);
    const pts = ds.map((d) => [d.lon, d.lat] as LngLat);
    const times = ds.map((d) => parseTime(d.acquired_at) ?? 0);
    const frps = ds.map((d) => d.frp_mw ?? 0);
    const center: LngLat = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const votes = new Map<string, number>();
    for (const d of ds) if (d.incident_id) votes.set(d.incident_id, (votes.get(d.incident_id) ?? 0) + 1);
    let incidentId: string | null = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (!incidentId) {
      incidentId =
        incidents.find((inc) => pointInGeometry(center, inc.geometry) || distanceKm(center, inc.center) < 3)?.id ?? null;
    }
    const earliestDet = ds[times.indexOf(Math.min(...times))];
    groups.push({
      id: `grp-${earliestDet.id}`,
      center,
      bbox: bboxOfPoints(pts),
      count: ds.length,
      maxFrp: Math.max(...frps),
      sumFrp: frps.reduce((a, b) => a + b, 0),
      latest: Math.max(...times),
      earliest: Math.min(...times),
      incidentId,
      detectionIds: ds.map((d) => d.id),
    });
  }
  return groups.sort((a, b) => b.count - a.count);
}

/** Illustrative influence shapes for groups with enough detections. */
export function coverageFromGroups(groups: FireGroup[], dets: Detection[]): CoverageCollection {
  const byId = new Map(dets.map((d) => [d.id, d]));
  const features: CoverageCollection['features'] = [];
  for (const g of groups) {
    if (g.count < 2) continue;
    const pts = g.detectionIds.map((id) => byId.get(id)).filter(Boolean).map((d) => [d!.lon, d!.lat] as LngLat);
    const geom = outlineAround(pts, { sigmaKm: 0.38, threshold: 0.5 });
    if (!geom) continue;
    features.push({
      type: 'Feature',
      id: g.id,
      properties: {
        group_id: g.id,
        visual_intensity: Math.min(1, Math.log10(g.sumFrp + 1) / 3),
        detection_count: g.count,
        illustrative_only: true,
      },
      geometry: geom,
    });
  }
  return { type: 'FeatureCollection', features };
}
