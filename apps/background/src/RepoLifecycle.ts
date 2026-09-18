import { setDofsDeviceSize } from '@edge-git/git-service';
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
    setDofsDeviceSize(this.dofs, 5 * 1024 * 1024 * 1024);
  }

  public async initRepo(): Promise<void> {
    await this.git.initRepo();
  }

  public async deleteRepo(): Promise<void> {
    // Targeted purge: remove repo content + release assets + name binding but
    // preserve the dofs schema tables (`dofs_files/dofs_chunks/dofs_meta`).
    // `ctx.storage.deleteAll()` also drops those tables while the warm DO
    // isolate (reused via `REPO.getByName(fullName)`) keeps its `Fs` instance,
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
  }

  public async ensureRepoInitialized(): Promise<void> {
    try {
      await this.isoGitFs.promises.stat('/repo/HEAD');
      return;
    } catch {
      // missing HEAD → init below
    }
    await this.initRepo();
  }

  public async prepare(): Promise<void> {
    await this.loadFullName();
    this.ensureDeviceSize();
    await this.ensureRepoInitialized();
    this.git.ensureFreshCache(this.config.getGitCacheTtlSeconds());
  }

  public getLimits(): FetchLimits & { maxCommands: number } {
    return {
      maxWants: this.config.getMaxFetchWants(),
      maxHaves: this.config.getMaxFetchHaves(),
      maxCommands: this.config.getMaxPushCommands(),
      maxObjects: this.config.getMaxPackObjects(),
      maxPackBytes: this.config.getMaxPackBytes(),
      maxFetchBodyBytes: this.config.getMaxFetchBodyBytes(),
    };
  }
}

export { RepoLifecycle };
