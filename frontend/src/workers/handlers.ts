/**
 * Compute jobs shared by the worker (compute.worker.ts) and the synchronous fallback used in tests
 * and browsers without module workers. Every job is a pure function of its inputs plus prepared
 * per-grid structures cached by key.
 */
import { coarseValues, prepareCoarse, prepareSurface, surfaceFeatures, type CoarsePrep, type SurfacePrep } from '../lib/surface';
import { nightFeatures } from '../lib/solar';
import { coverageFromGroups, groupDetections } from '../lib/fireGroups';
import { windLevels } from '../lib/windLevels';
import { buildWindField } from '../lib/windField';
import type { Detection, Incident } from '../types';

export type Job =
  | { op: 'prepareSurface'; key: string; centers: Float32Array }
  | { op: 'surface'; key: string; values: Float32Array; stops: [number, string][] }
  | { op: 'prepareCoarse'; key: string; centers: Float32Array }
  | { op: 'coarse'; key: string; values: Float32Array }
  | { op: 'night'; t: number }
  | { op: 'fires'; detections: Detection[]; incidents: Incident[] }
  | { op: 'windLevels'; points: [number, number][] }
  | { op: 'windField'; points: [number, number][]; speed: Float32Array; from: Float32Array };

const surfaces = new Map<string, SurfacePrep>();
const coarse = new Map<string, CoarsePrep>();
const remember = <T,>(m: Map<string, T>, key: string, v: T) => {
  m.set(key, v);
  while (m.size > 3) m.delete(m.keys().next().value!);
};

export function handle(job: Job): { result: unknown; transfer?: Transferable[] } {
  switch (job.op) {
    case 'prepareSurface': {
      remember(surfaces, job.key, prepareSurface(job.centers));
      return { result: true };
    }
    case 'surface': {
      const prep = surfaces.get(job.key);
      if (!prep) throw new Error('surface not prepared');
      return { result: { type: 'FeatureCollection', features: surfaceFeatures(prep, job.values, job.stops) } };
    }
    case 'prepareCoarse': {
      const prep = prepareCoarse(job.centers);
      remember(coarse, job.key, prep);
      return { result: { type: 'FeatureCollection', features: prep.features } };
    }
    case 'coarse': {
      const prep = coarse.get(job.key);
      if (!prep) throw new Error('coarse not prepared');
      const out = coarseValues(prep, job.values);
      return { result: out, transfer: [out.buffer] };
    }
    case 'night':
      return { result: { type: 'FeatureCollection', features: nightFeatures(job.t) } };
    case 'fires': {
      const groups = groupDetections(job.detections, job.incidents);
      return { result: { groups, coverage: coverageFromGroups(groups, job.detections) } };
    }
    case 'windField': {
      const f = buildWindField(job.points, job.speed, job.from);
      return { result: f, transfer: [f.u.buffer, f.v.buffer] };
    }
    case 'windLevels': {
      const out = windLevels(job.points);
      return { result: out, transfer: [out.buffer] };
    }
  }
}
