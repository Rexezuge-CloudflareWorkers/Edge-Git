import { Fs } from 'dofs';

/**
 * Encapsulated Durable Object filesystem factory.
 *
 * Previously `packages/git-service/src/index.ts` re-exported `Fs as DofsFs`
 * directly, leaking the third-party `dofs` constructor API to
 * `apps/background`. This adapter keeps `dofs` an implementation detail of
 * `git-service`: callers create filesystems and isomorphic-git clients
 * through factories instead of `new DofsFs(ctx, env, opts)`.
 *
 * OO roles: **Adapter** (dofs device behind the `DofsFs` alias) +
 * **Factory** (`DofsFsFactory`/`createDofsFs`) + **Specification**
 * (`validateChunkSize`). Device sizing is best-effort by design: use
 * `trySetDofsDeviceSize` when the caller needs to know whether the sizing
 * applied, or `setDofsDeviceSize` (never throws) in lifecycle paths where
 * the write path surfaces real errors.
 */
type DofsFs = Fs;

/**
 * Minimal structural view of a Durable Object context (branded, no `any`).
 */
type DofsFsContext = {
  readonly storage?: unknown;
  readonly [key: string]: unknown;
};

/**
 * Minimal structural view of a Worker environment (branded, no `any`).
 */
type DofsFsEnvironment = {
  readonly [key: string]: unknown;
};

interface DofsFsOptions {
  chunkSize?: number;
}

/**
 * Factory surface for callers that need injectable filesystem creation.
 */
interface DofsFsFactory {
  create(ctx: DofsFsContext, env: DofsFsEnvironment, options?: DofsFsOptions): DofsFs;
}

const DEFAULT_CHUNK_SIZE = 512 * 1024;
const MAX_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Pure chunk-size specification: returns the validated size or throws.
 * Extracted so route/DO layers can validate without constructing storage.
 */
function validateChunkSize(chunkSize: unknown): number {
  if (typeof chunkSize !== 'number' || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE) {
    const seen = typeof chunkSize === 'number' ? String(chunkSize) : typeof chunkSize;
    throw new Error(`Invalid chunkSize: ${seen} (must be 1..${MAX_CHUNK_SIZE})`);
  }
  return chunkSize;
}

function createDofsFs(ctx: DofsFsContext, env: DofsFsEnvironment, options?: DofsFsOptions): DofsFs;
function createDofsFs(ctx: unknown, env: unknown, options?: DofsFsOptions): DofsFs;
function createDofsFs(ctx: unknown, env: unknown, options: DofsFsOptions = {}): DofsFs {
  const { chunkSize = DEFAULT_CHUNK_SIZE } = options;
  const validated = validateChunkSize(chunkSize);
  return new Fs(ctx as ConstructorParameters<typeof Fs>[0], env as ConstructorParameters<typeof Fs>[1], { chunkSize: validated });
}

/**
 * Best-effort device sizing that reports success. Returns `false` (never
 * throws) when the device rejects the size or lacks the method — e.g.
 * ENOSPC, already-set, or unit-test fakes.
 */
function trySetDofsDeviceSize(dofs: DofsFs, bytes: number): boolean {
  try {
    (dofs as unknown as { setDeviceSize: (n: number) => void }).setDeviceSize(bytes);
    return true;
  } catch {
    return false;
  }
}

function setDofsDeviceSize(dofs: DofsFs, bytes: number): void {
  try {
    dofs.setDeviceSize(bytes);
  } catch {
    // ENOSPC / already set — safe to ignore, write path surfaces real errors.
  }
}

export { createDofsFs, setDofsDeviceSize, trySetDofsDeviceSize, validateChunkSize, DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE };
export type { DofsFs, DofsFsContext, DofsFsEnvironment, DofsFsFactory, DofsFsOptions };
