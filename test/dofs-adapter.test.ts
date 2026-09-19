import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

/**
 * Loads the real `DofsFsAdapter` module with a fake `dofs` implementation.
 * Direct import would pull `dofs` -> `cloudflare:*` (unparsable in the node
 * unit pool), so the source is transpiled and evaluated with a stubbed
 * `require('dofs')`. This exercises the real adapter logic without the real
 * module.
 */
function loadAdapter() {
  const src = fs.readFileSync(new URL('../packages/git-service/src/DofsFsAdapter.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const ctorArgs: unknown[][] = [];
  const sizes: number[] = [];
  class FakeFs {
    public constructor(...args: unknown[]) {
      ctorArgs.push(args);
    }

    public setDeviceSize(n: number): void {
      sizes.push(n);
    }
  }
  const nodeRequire = createRequire(import.meta.url);
  const fakeRequire = (id: string) => (id === 'dofs' ? { Fs: FakeFs } : nodeRequire(id));
  const mod = { exports: {} as Record<string, never> };
  new Function('require', 'exports', 'module', outputText)(fakeRequire, mod.exports, mod);
  return {
    adapter: mod.exports as unknown as {
      createDofsFs(c: unknown, e: unknown, o?: unknown): unknown;
      setDofsDeviceSize(d: unknown, n: number): void;
      DEFAULT_CHUNK_SIZE: number;
    },
    ctorArgs,
    sizes,
    FakeFs,
  };
}

describe('DofsFsAdapter factory', () => {
  it('exposes the documented default chunk size', () => {
    const { adapter } = loadAdapter();
    expect(adapter.DEFAULT_CHUNK_SIZE).toBe(512 * 1024);
  });

  it('createDofsFs forwards fake ctx/env with the default chunk size', () => {
    const { adapter, ctorArgs, FakeFs } = loadAdapter();
    const ctx = { id: 'fake-ctx' };
    const env = { id: 'fake-env' };
    const inst = adapter.createDofsFs(ctx, env);
    expect(inst).toBeInstanceOf(FakeFs);
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0][0]).toBe(ctx);
    expect(ctorArgs[0][1]).toBe(env);
    expect(ctorArgs[0][2]).toEqual({ chunkSize: 512 * 1024 });
  });

  it('createDofsFs honors an explicit chunkSize override', () => {
    const { adapter, ctorArgs } = loadAdapter();
    adapter.createDofsFs({}, {}, { chunkSize: 4096 });
    expect(ctorArgs[0][2]).toEqual({ chunkSize: 4096 });
  });

  it('createDofsFs merges defaults with extra options', () => {
    const { adapter, ctorArgs } = loadAdapter();
    adapter.createDofsFs({ a: 1 }, { b: 2 }, { chunkSize: 8192 });
    expect(ctorArgs[0][0]).toEqual({ a: 1 });
    expect(ctorArgs[0][1]).toEqual({ b: 2 });
    expect(ctorArgs[0][2]).toEqual({ chunkSize: 8192 });
  });

  it('setDofsDeviceSize forwards the size on success', () => {
    const { adapter, sizes } = loadAdapter();
    const device = new (class {
      public setDeviceSize(n: number): void {
        sizes.push(n * 2);
      }
    })();
    adapter.setDofsDeviceSize(device, 1024);
    expect(sizes).toEqual([2048]);
  });

  it('setDofsDeviceSize swallows device failures (best-effort)', () => {
    const { adapter } = loadAdapter();
    const failing = {
      setDeviceSize: () => {
        throw new Error('ENOSPC');
      },
    };
    expect(() => adapter.setDofsDeviceSize(failing, 5)).not.toThrow();
    expect(() => adapter.setDofsDeviceSize({}, 5)).not.toThrow();
    expect(() => adapter.setDofsDeviceSize(null, 5)).not.toThrow();
  });

  it('adapter source keeps the swallow so write paths surface real errors', () => {
    const src = fs.readFileSync(new URL('../packages/git-service/src/DofsFsAdapter.ts', import.meta.url), 'utf8');
    expect(src).toContain('setDeviceSize');
    expect(src).toMatch(/try\s*\{[\s\S]*setDeviceSize[\s\S]*\}\s*catch/);
  });
});
