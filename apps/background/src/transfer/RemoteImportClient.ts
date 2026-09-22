import { workerFetchAdapter } from './fetchAdapter';
import type { RemoteGitFetcher } from '@edge-git/git-protocol';

interface RemoteImportClientOptions {
  timeoutMs?: number;
  maxRedirects?: number;
}

function isRetryableImportStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

class RemoteImportClient {
  private readonly fetcher: RemoteGitFetcher;
  private readonly timeoutMs: number;

  constructor(fetcher: RemoteGitFetcher = workerFetchAdapter(), options: RemoteImportClientOptions = {}) {
    this.fetcher = fetcher;
    this.timeoutMs = options.timeoutMs ?? 30_000;
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

export { RemoteImportClient, isRetryableImportStatus };
export type { RemoteImportClientOptions };
