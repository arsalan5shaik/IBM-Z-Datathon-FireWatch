/**
 * Off-main-thread compute client. Heavy derived data (fire clustering + influence contours, the
 * statewide risk surface, night polygons, wind thinning) runs in a module worker so
 * map interaction and playback stay smooth. Falls back to synchronous execution where workers are
 * unavailable (unit tests, very old browsers) with identical results.
 */
import { handle, type Job } from '../workers/handlers';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let failed = false;
let seq = 0;
const pending = new Map<number, Pending>();
/** Jobs in flight per op; used by the perf overlay. */
export const inFlight = new Map<string, number>();

function getWorker(): Worker | null {
  if (failed || typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/compute.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error ?? 'compute failed'));
    };
    worker.onerror = () => {
      // A broken worker (CSP, bundling) must not take features down: switch to synchronous mode.
      failed = true;
      worker?.terminate();
      worker = null;
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error('worker unavailable'));
      }
    };
    return worker;
  } catch {
    failed = true;
    return null;
  }
}

export function compute<T>(job: Job, transfer: Transferable[] = []): Promise<T> {
  inFlight.set(job.op, (inFlight.get(job.op) ?? 0) + 1);
  const done = <V,>(v: V) => {
    inFlight.set(job.op, Math.max(0, (inFlight.get(job.op) ?? 1) - 1));
    return v;
  };
  const w = getWorker();
  if (!w) {
    try {
      return Promise.resolve(done(handle(job).result as T));
    } catch (e) {
      done(null);
      return Promise.reject(e);
    }
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => resolve(done(v as T)),
      reject: (e) => {
        done(null);
        // Retry synchronously once if the worker died.
        if (failed) {
          try {
            resolve(handle(job).result as T);
          } catch (err) {
            reject(err as Error);
          }
        } else reject(e);
      },
    });
    w.postMessage({ id, job }, transfer);
  });
}

export const workerActive = () => !!worker && !failed;
