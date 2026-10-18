/// <reference lib="webworker" />
import { handle, type Job } from './handlers';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<{ id: number; job: Job }>) => {
  const { id, job } = e.data;
  try {
    const { result, transfer } = handle(job);
    self.postMessage({ id, ok: true, result }, transfer ?? []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
