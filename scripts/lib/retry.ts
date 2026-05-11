/**
 * Tiny retry-with-backoff for transient HTTP errors. Used by enrichment
 * scripts that hammer the public MLB API and occasionally get 5xx / hangups.
 *
 * Retries on:
 *  - any non-Error throw (network blip)
 *  - MlbApiError with status >= 500 OR no status (fetch failed)
 *  - any Error whose message includes "fetch failed", "ECONNRESET", or "ETIMEDOUT"
 */
import { MlbApiError } from './mlb.js';

export interface RetryOpts {
  attempts?: number;     // default 4
  baseDelayMs?: number;  // default 400
  maxDelayMs?: number;   // default 4000
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseDelay = opts.baseDelayMs ?? 400;
  const maxDelay = opts.maxDelayMs ?? 4000;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      const delay = Math.min(maxDelay, baseDelay * 2 ** i);
      await sleep(delay + Math.floor(Math.random() * 100));
    }
  }
  throw lastErr;
}

function isTransient(err: unknown): boolean {
  if (err instanceof MlbApiError) {
    if (typeof err.status === 'number') return err.status >= 500;
    return true; // no status = network failure
  }
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    return m.includes('fetch failed') || m.includes('econnreset') || m.includes('etimedout') || m.includes('econnrefused');
  }
  return true;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
