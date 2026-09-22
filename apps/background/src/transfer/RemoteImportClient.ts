import { workerFetchAdapter, resolveMaxRedirects } from './fetchAdapter';
import type { RemoteGitFetcher } from '@edge-git/git-protocol';

interface RemoteImportClientOptions {
  timeoutMs?: number;
  maxRedirects?: number;
}

const DEFAULT_IMPORT_TIMEOUT_MS = 30_000;
const MAX_IMPORT_TIMEOUT_MS = 120_000;
const MAX_IMPORT_BACKOFF_MS = 30_000;

function isRetryableImportStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Pure retry backoff (Strategy pattern): capped exponential starting at 1s.
 * Keeps delay math unit-testable without timers; callers `await sleep()`.
 */
function importBackoffMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) return 1000;
  return Math.min(MAX_IMPORT_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 5));
}

/**
 * Thin timeout + redirect-budget facade over a `RemoteGitFetcher`.
 * `maxRedirects` is now honored (previously accepted but ignored — the
 * adapter hardcoded 3 hops). Invalid budgets/timeouts fail fast instead of
 * silently degrading the transfer.
 */
class RemoteImportClient {
  private readonly fetcher: RemoteGitFetcher;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;

  constructor(fetcher?: RemoteGitFetcher, options: RemoteImportClientOptions = {}) {
    const { timeoutMs = DEFAULT_IMPORT_TIMEOUT_MS, maxRedirects } = options;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_IMPORT_TIMEOUT_MS) {
      throw new Error(`Invalid timeoutMs: ${String(timeoutMs)} (must be 1..${MAX_IMPORT_TIMEOUT_MS})`);
    }
    this.maxRedirects = resolveMaxRedirects(maxRedirects);
    this.fetcher = fetcher ?? workerFetchAdapter({ maxRedirects: this.maxRedirects });
    this.timeoutMs = timeoutMs;
  }

  public getTimeoutMs(): number {
    return this.timeoutMs;
  }

  public getMaxRedirects(): number {
    return this.maxRedirects;
  }

  private signal(parent?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (parent) {
      if (parent.aborted) controller.abort();
      else parent.addEventListener('abort', () => controller.abort(), { once: true });
    }
    return { signal: controller.signal, cancel: () => clearTimeout(timer) };
  }

  public async get(url: string, headers: Record<string, string>, parent?: AbortSignal) {
    const { signal, cancel } = this.signal(parent);
    try {
      return await this.fetcher.get(url, headers, signal);
    } finally {
      cancel();
    }
  }

  public async post(url: string, headers: Record<string, string>, body: Uint8Array, parent?: AbortSignal) {
    const { signal, cancel } = this.signal(parent);
    try {
      return await this.fetcher.post(url, headers, body, signal);
    } finally {
      cancel();
    }
  }
}

export { RemoteImportClient, isRetryableImportStatus, importBackoffMs, DEFAULT_IMPORT_TIMEOUT_MS, MAX_IMPORT_TIMEOUT_MS };
export type { RemoteImportClientOptions };
