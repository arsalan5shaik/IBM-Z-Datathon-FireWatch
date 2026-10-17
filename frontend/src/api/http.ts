import type { ApiError } from '../types';

export class HttpError extends Error implements ApiError {
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/**
 * fetch + JSON with a timeout, abort support and the contract's error envelope
 * `{ "error": { "code", "message" } }` normalised into HttpError.
 */
export async function fetchJson<T>(
  url: string,
  { timeoutMs = 20_000, signal, method = 'GET', body }: { timeoutMs?: number; signal?: AbortSignal; method?: string; body?: unknown } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  const onAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      if (!res.ok) throw new HttpError('http_error', `HTTP ${res.status}`, res.status);
      throw new HttpError('bad_json', `Invalid JSON from ${url}`, res.status);
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new HttpError(err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`, res.status);
    }
    return data as T;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (ctrl.signal.aborted && !signal?.aborted) throw new HttpError('timeout', 'The request timed out');
    if (signal?.aborted) throw new HttpError('aborted', 'Request cancelled');
    throw new HttpError('network', navigator.onLine ? 'Could not reach the server' : 'You appear to be offline');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
