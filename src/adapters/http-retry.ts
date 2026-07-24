/**
 * Shared HTTP retry utility with exponential backoff + jitter.
 *
 * Retries on transient failures: network errors and 429/500/502/503/504.
 * Does NOT retry on 400/401/403/404 — those are caller bugs, not transients.
 * On final failure, captures the raw response text for diagnostics.
 */

export interface RetryOptions {
  maxAttempts?: number;       // default 3
  baseDelayMs?: number;       // default 500
  maxDelayMs?: number;        // default 10_000
  /** Per-attempt fetch timeout in ms. 0 = no timeout (default). */
  timeoutMs?: number;
  /** injected for tests; defaults to a real setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type RetryOutcome =
  | { ok: true; resp: Response }
  | {
      ok: false;
      /** HTTP status, or 0 for a network error. */
      status: number;
      /** Raw response body (truncated to 500 chars) or the network error message. */
      rawBody: string;
      attempts: number;
    };

// HTTP status codes we treat as transient (worth retrying).
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<RetryOutcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  const timeoutMs = opts.timeoutMs ?? 0;
  const sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (init.signal?.aborted) {
      return { ok: false, status: 0, rawBody: "request aborted by caller", attempts: attempt };
    }
    let resp: Response;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = timeoutMs > 0 ? new AbortController() : null;
    if (controller && timeoutMs > 0) {
      abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    }
    const signal = controller && init.signal
      ? AbortSignal.any([controller.signal, init.signal])
      : controller?.signal ?? init.signal;
    const initWithSignal: RequestInit = signal ? { ...init, signal } : init;
    try {
      resp = await fetchImpl(url, initWithSignal);
      if (abortTimer !== undefined) clearTimeout(abortTimer);
    } catch (e) {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      lastBody = (e as Error).message;
      lastStatus = 0;
      if (init.signal?.aborted) {
        return { ok: false, status: 0, rawBody: "request aborted by caller", attempts: attempt };
      }
      if (attempt < maxAttempts) {
        await sleep(jitteredDelay(baseDelay, attempt, maxDelay));
        continue;
      }
      return { ok: false, status: 0, rawBody: lastBody, attempts: attempt };
    }

    if (abortTimer !== undefined) clearTimeout(abortTimer);
    if (resp.ok) return { ok: true, resp };

    // Don't retry client errors that aren't transient.
    if (!RETRYABLE.has(resp.status)) {
      lastBody = await safeText(resp);
      return { ok: false, status: resp.status, rawBody: lastBody.slice(0, 500), attempts: attempt };
    }

    lastStatus = resp.status;
    lastBody = await safeText(resp);

    if (attempt < maxAttempts) {
      // Honour Retry-After header if present (used by 429).
      const retryAfter = resp.headers?.get?.("retry-after") ?? null;
      const delay = retryAfter ? Math.min(parseFloat(retryAfter) * 1000, maxDelay) : jitteredDelay(baseDelay, attempt, maxDelay);
      await sleep(delay);
    }
  }

  return { ok: false, status: lastStatus, rawBody: lastBody.slice(0, 500), attempts: maxAttempts };
}

function jitteredDelay(base: number, attempt: number, max: number): number {
  // Full-jitter exponential backoff: random in [0, base * 2^(attempt-1)]
  const cap = Math.min(base * Math.pow(2, attempt - 1), max);
  return Math.random() * cap;
}

async function safeText(resp: Response): Promise<string> {
  try { return await resp.text(); } catch { return "<no body>"; }
}
