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
    await this.ctx.storage.deleteAll();
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
