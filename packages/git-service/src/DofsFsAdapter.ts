import { Fs } from 'dofs';

/**
 * Encapsulated Durable Object filesystem factory.
 *
 * Previously `packages/git-service/src/index.ts` re-exported `Fs as DofsFs`
 * directly, leaking the third-party `dofs` constructor API to
 * `apps/background`. This adapter keeps `dofs` an implementation detail of
 * `git-service`: callers create filesystems and isomorphic-git clients
 * through factories instead of `new DofsFs(ctx, env, opts)`.
 */
type DofsFs = Fs;

interface DofsFsOptions {
  chunkSize?: number;
}

const DEFAULT_CHUNK_SIZE = 512 * 1024;

function createDofsFs(ctx: unknown, env: unknown, options: DofsFsOptions = {}): DofsFs {
  return new Fs(ctx as ConstructorParameters<typeof Fs>[0], env as ConstructorParameters<typeof Fs>[1], {
    chunkSize: DEFAULT_CHUNK_SIZE,
    ...options,
  });
}

function setDofsDeviceSize(dofs: DofsFs, bytes: number): void {
  try {
    dofs.setDeviceSize(bytes);
  } catch {
    // ENOSPC / already set — safe to ignore, write path surfaces real errors.
  }
}

export { createDofsFs, setDofsDeviceSize, DEFAULT_CHUNK_SIZE };
export type { DofsFs, DofsFsOptions };
