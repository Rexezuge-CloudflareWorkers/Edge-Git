import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { ftsOrLike } from '@edge-git/backend-services/search';
import { RemoteImportClient, isRetryableImportStatus, importBackoffMs } from '@edge-git/background/transfer/RemoteImportClient';
import { resolveMaxRedirects } from '@edge-git/background/transfer/fetchAdapter';
import { appendUniqueEmails, decodeBlobContent } from '@/workers/routes/CodeownerHelpers';
import { deduplicateRepoRows, parseLimit } from '@/workers/routes/UserProfileVisibility';

/**
 * Hardening pass 3: covers the refactored specifications/factories.
 * - `DofsFsAdapter.validateChunkSize` + `trySetDofsDeviceSize` (loaded via
 *   transpile like `dofs-adapter.test.ts` — direct import pulls `dofs`).
 * - `RemoteImportClient` honoring `maxRedirects` (previously ignored) +
 *   timeout validation + `importBackoffMs` retry policy.
 * - `ftsOrLike` deduplicated fallback contract.
 * - Pure CODEOWNERS/profile helpers extracted for testability.
 */
function loadAdapter() {
  const src = fs.readFileSync(new URL('../packages/git-service/src/DofsFsAdapter.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  class FakeFs {
    public constructor(..._args: unknown[]) {}
    public setDeviceSize(_n: number): void {}
  }
  const nodeRequire = createRequire(import.meta.url);
  const fakeRequire = (id: string) => (id === 'dofs' ? { Fs: FakeFs } : nodeRequire(id));
  const mod = { exports: {} as Record<string, never> };
  new Function('require', 'exports', 'module', outputText)(fakeRequire, mod.exports, mod);
  return mod.exports as unknown as {
    createDofsFs(c: unknown, e: unknown, o?: unknown): unknown;
    setDofsDeviceSize(d: unknown, n: number): void;
    trySetDofsDeviceSize(d: unknown, n: number): boolean;
    validateChunkSize(n: unknown): number;
    DEFAULT_CHUNK_SIZE: number;
    MAX_CHUNK_SIZE: number;
  };
}

describe('harden pass3: DofsFsAdapter specifications', () => {
  it('validates chunk sizes without constructing storage', () => {
    const adapter = loadAdapter();
    expect(adapter.validateChunkSize(4096)).toBe(4096);
    expect(() => adapter.validateChunkSize(0)).toThrow(/Invalid chunkSize/);
    expect(() => adapter.validateChunkSize(-1)).toThrow(/Invalid chunkSize/);
    expect(() => adapter.validateChunkSize(adapter.MAX_CHUNK_SIZE + 1)).toThrow(/Invalid chunkSize/);
    expect(() => adapter.validateChunkSize(Number.NaN)).toThrow(/Invalid chunkSize/);
  });

  it('createDofsFs rejects invalid sizes fail-fast', () => {
    const adapter = loadAdapter();
    expect(() => adapter.createDofsFs({}, {}, { chunkSize: 0 })).toThrow(/Invalid chunkSize/);
  });

  it('trySetDofsDeviceSize reports success instead of swallowing silently', () => {
    const adapter = loadAdapter();
    let seen = 0;
    expect(
      adapter.trySetDofsDeviceSize(
        {
          setDeviceSize: (n: number) => {
            seen = n;
          },
        },
        1024,
      ),
    ).toBe(true);
    expect(seen).toBe(1024);
    expect(
      adapter.trySetDofsDeviceSize(
        {
          setDeviceSize: () => {
            throw new Error('ENOSPC');
          },
        },
        5,
      ),
    ).toBe(false);
    expect(adapter.trySetDofsDeviceSize({}, 5)).toBe(false);
    expect(adapter.trySetDofsDeviceSize(null, 5)).toBe(false);
    // Legacy void wrapper keeps lifecycle call sites non-throwing.
    expect(() =>
      adapter.setDofsDeviceSize(
        {
          setDeviceSize: () => {
            throw new Error('x');
          },
        },
        5,
      ),
    ).not.toThrow();
  });
});

describe('harden pass3: RemoteImportClient honors redirect budget', () => {
  it('resolves and clamps redirect budgets', () => {
    expect(resolveMaxRedirects(undefined)).toBe(3);
    expect(resolveMaxRedirects(0)).toBe(0);
    expect(resolveMaxRedirects(10)).toBe(10);
    expect(() => resolveMaxRedirects(-1)).toThrow(/Invalid maxRedirects/);
    expect(() => resolveMaxRedirects(11)).toThrow(/Invalid maxRedirects/);
  });

  it('validates timeouts fail-fast and exposes budget accessors', () => {
    const client = new RemoteImportClient(undefined, { timeoutMs: 5_000, maxRedirects: 1 });
    expect(client.getTimeoutMs()).toBe(5_000);
    expect(client.getMaxRedirects()).toBe(1);
    expect(() => new RemoteImportClient(undefined, { timeoutMs: 0 })).toThrow(/Invalid timeoutMs/);
    expect(() => new RemoteImportClient(undefined, { timeoutMs: 999_999 })).toThrow(/Invalid timeoutMs/);
    expect(() => new RemoteImportClient(undefined, { maxRedirects: 99 })).toThrow(/Invalid maxRedirects/);
  });

  it('delegates get/post through the timeout wrapper', async () => {
    const calls: string[] = [];
    const fetcher = {
      get: async () => {
        calls.push('get');
        return { status: 200, body: new Uint8Array() };
      },
      post: async () => {
        calls.push('post');
        return { status: 200, body: new Uint8Array() };
      },
    };
    const client = new RemoteImportClient(fetcher, { timeoutMs: 1_000 });
    await client.get('https://example.com/a', {});
    await client.post('https://example.com/b', {}, new Uint8Array([1]));
    expect(calls).toEqual(['get', 'post']);
  });

  it('retry classifier + capped backoff policy', () => {
    expect(isRetryableImportStatus(429)).toBe(true);
    expect(isRetryableImportStatus(503)).toBe(true);
    expect(isRetryableImportStatus(404)).toBe(false);
    expect(isRetryableImportStatus(200)).toBe(false);
    expect(importBackoffMs(0)).toBe(1_000);
    expect(importBackoffMs(1)).toBe(2_000);
    expect(importBackoffMs(99)).toBe(30_000);
    expect(importBackoffMs(-1)).toBe(1_000);
  });
});

describe('harden pass3: ftsOrLike fallback contract', () => {
  const missing = (e: unknown) => /no such table/i.test(String((e as Error)?.message ?? e));

  it('returns FTS rows without touching LIKE', async () => {
    let likeCalls = 0;
    const rows = await ftsOrLike(
      async () => ['a'],
      async () => {
        likeCalls += 1;
        return ['b'];
      },
      missing,
    );
    expect(rows).toEqual(['a']);
    expect(likeCalls).toBe(0);
  });

  it('falls back to LIKE on missing FTS schema', async () => {
    const rows = await ftsOrLike(
      async () => {
        throw new Error('no such table: repos_fts');
      },
      async () => ['like'],
      missing,
    );
    expect(rows).toEqual(['like']);
  });

  it('falls back to LIKE on genuine FTS errors too', async () => {
    const rows = await ftsOrLike(
      async () => {
        throw new Error('syntax error');
      },
      async () => ['like'],
      missing,
    );
    expect(rows).toEqual(['like']);
  });

  it('returns [] when LIKE schema is also missing, rethrows genuine D1 errors', async () => {
    const empty = await ftsOrLike(
      async () => {
        throw new Error('no such table: fts');
      },
      async () => {
        throw new Error('no such table: repos');
      },
      missing,
    );
    expect(empty).toEqual([]);
    await expect(
      ftsOrLike(
        async () => {
          throw new Error('fts boom');
        },
        async () => {
          throw new Error('disk I/O error');
        },
        missing,
      ),
    ).rejects.toThrow(/disk I\/O/);
  });
});

describe('harden pass3: pure CODEOWNERS + profile helpers', () => {
  it('decodeBlobContent rejects binary/missing/blank payloads', () => {
    expect(decodeBlobContent(null)).toBeNull();
    expect(decodeBlobContent({ isBinary: true, contentBase64: 'eA==' })).toBeNull();
    expect(decodeBlobContent({ contentBase64: '' })).toBeNull();
    const encoded = Buffer.from('* @alice\n', 'utf8').toString('base64');
    expect(decodeBlobContent({ contentBase64: encoded })).toContain('@alice');
  });

  it('appendUniqueEmails lowercases, excludes self, dedupes, caps', () => {
    const out = appendUniqueEmails([], ['A@x.com', 'a@X.com', 'self@x.com', '', 'b@x.com'], 'self@x.com', 10);
    expect(out).toEqual(['a@x.com', 'b@x.com']);
    expect(appendUniqueEmails(['a@x.com'], ['b@x.com', 'c@x.com'], '', 2)).toEqual(['a@x.com', 'b@x.com']);
  });

  it('deduplicateRepoRows merges org+owner listings by id', () => {
    const rows = deduplicateRepoRows(
      [
        { id: '1', updated_at: 1 },
        { id: '2', updated_at: 2 },
      ] as Array<{ id: string; updated_at: number }>,
      [
        { id: '2', updated_at: 3 },
        { id: '3', updated_at: 4 },
      ] as Array<{ id: string; updated_at: number }>,
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['1', '2', '3']);
    // Last write wins so owner-listing freshness overrides stale org rows.
    expect(rows.find((r) => r.id === '2')?.updated_at).toBe(3);
  });

  it('parseLimit keeps safe defaults (regression guard)', () => {
    expect(parseLimit('https://x/users/a?limit=abc')).toBe(20);
    expect(parseLimit('https://x/users/a?limit=500')).toBe(100);
  });
});
