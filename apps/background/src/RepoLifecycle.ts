import { createDofsFs, setDofsDeviceSize } from '@edge-git/git-service';
import type { DofsFs, GitService, IsoGitFs } from '@edge-git/git-service';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import type { FetchLimits } from './FetchHandler';

type IsoGitFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

/**
 * Repository lifecycle (init/delete/ensure/device/limits).
 * Extracted from `RepoWorker` (491 LOC god-file) so the Durable Object keeps
 * only routing + composition while lifecycle + cache policy live here (Otter
 * Facade pattern). Uses injected `AppConfiguration` instead of
 * `ConfigurationManager` statics scattered across call sites.
 */
class RepoLifecycle {
  private initPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly dofs: DofsFs,
    private readonly isoGitFs: IsoGitFsClient,
    private readonly git: GitService,
    private readonly config: AppConfiguration,
    private readonly getFullName: () => string | undefined,
    private readonly loadFullName: () => Promise<void>,
  ) {}

  public ensureDeviceSize(): void {
    setDofsDeviceSize(this.dofs, this.config.getDoDeviceBytes());
  }

  public async initRepo(): Promise<void> {
    await this.git.initRepo();
  }

  public async deleteRepo(): Promise<void> {
    // Targeted purge: remove repo content + release assets + name binding but
    // preserve the dofs schema tables (`dofs_files/dofs_chunks/dofs_meta`).
    // `ctx.storage.deleteAll()` also drops those tables while the warm DO
    // isolate (reused via canonical-key `REPO.getByName`) keeps its `Fs` instance,
    // whose schema bootstrap runs only once in the constructor — a later
    // recreate of the same name then fails with `no such table: dofs_files`.
    for (const path of ['/repo', '/release-assets']) {
      try {
        await this.isoGitFs.promises.rmdir(path, { recursive: true });
      } catch {
        // Best-effort: path may not exist (never pushed / no assets).
      }
    }
    await this.ctx.storage.delete('fullName');
    // Drop cached refs so a recreated same-name repo never serves stale refs
    // within the cache TTL. Optional-chained for fakes lacking the method.
    (this.git as unknown as { clearCache?: () => void }).clearCache?.();
    this.initPromise = null;
    this.initialized = false;
  }

  public async vacuum(): Promise<{ vacuumed: boolean; reason: string }> {
    // Background full reclaim for deleted repos (via `RepoVacuumTask`). The
    // synchronous `deleteRepo` above keeps a targeted purge so same-name
    // recreates work on the warm isolate; this step runs minutes later and
    // drops everything — including the dofs schema tables and their SQLite
    // pages — so the dashboard stops reporting storage for the dead DO.
    // Recreate-safety: a recreated repo re-persists the `fullName` binding
    // first, so a present binding means the isolate is live again and the
    // wipe is skipped. The guard read and the wipe have no await between
    // them, so no interleaving RPC can slip a rename in the middle.
    const bound = await this.ctx.storage.get<string>('fullName').catch(() => null);
    if (bound) return { vacuumed: false, reason: 'name-live' };
    await this.ctx.storage.deleteAll();
    // `deleteAll` dropped the dofs schema tables while this warm isolate
    // keeps its `Fs` instance (schema bootstrap runs once in its
    // constructor). Re-bootstrap via a throwaway `Fs` — its constructor
    // schedules `blockConcurrencyWhile(ensureSchema)` (`CREATE TABLE IF NOT
    // EXISTS`), which gates any later recreate behind the fresh schema.
    // Best-effort for fakes lacking `blockConcurrencyWhile`.
    try {
      createDofsFs(this.ctx, this.env);
    } catch {
      // storage is already empty; a later recreate re-inits on a fresh isolate.
    }
    (this.git as unknown as { clearCache?: () => void }).clearCache?.();
    this.initPromise = null;
    this.initialized = false;
    return { vacuumed: true, reason: 'reclaimed' };
  }

  public async ensureRepoInitialized(): Promise<void> {
    // Warm-isolate fast path: a previous `prepare()` already verified `/repo`
    // exists in this isolate lifetime. Skips one `stat` (1-2 SQLite rows)
    // per RPC, which dominates `rows_read` on read-heavy workloads.
    if (this.initialized) return;
    try {
      await this.isoGitFs.promises.stat('/repo/HEAD');
      this.initialized = true;
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Only fail closed on definitive storage errors; missing/corrupt HEAD
      // (ENOENT, not-found, generic fake errors) triggers lazy init below.
      // Memoized so concurrent fetch+RPC inits share one init (no TOCTOU).
      if (/EIO|EACCES|EPERM|EROFS|ENOSPC/i.test(message)) throw error;
    }
    let current = this.initPromise;
    if (!current) {
      const started = this.initRepo();
      const holder: { gate: Promise<void> | null } = { gate: null };
      holder.gate = (async () => {
        try {
          await started;
        } finally {
          // Clear only our own generation so a retry that starts after a
          // failure cannot be wiped by a stale finally from the previous run.
          if (this.initPromise === holder.gate) this.initPromise = null;
        }
      })();
      this.initPromise = holder.gate;
      current = holder.gate;
    }
    await current;
    this.initialized = true;
  }

  public async prepare(): Promise<void> {
    await this.loadFullName();
    this.ensureDeviceSize();
    await this.ensureRepoInitialized();
    this.git.ensureFreshCache(this.config.getGitCacheTtlSeconds());
  }

  public getLimits(): FetchLimits & { maxCommands: number; maxRefs: number } {
    return {
      maxWants: this.config.getMaxFetchWants(),
      maxHaves: this.config.getMaxFetchHaves(),
      maxCommands: this.config.getMaxPushCommands(),
      maxObjects: this.config.getMaxPackObjects(),
      maxPackBytes: this.config.getMaxPackBytes(),
      maxFetchBodyBytes: this.config.getMaxFetchBodyBytes(),
      maxRefs: this.config.getMaxPushCommands() * 10,
    };
  }
}

export { RepoLifecycle };
