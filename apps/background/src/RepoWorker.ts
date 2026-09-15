import { DurableObject } from 'cloudflare:workers';
import { DofsFs, GitService, IsoGitFs } from '@edge-git/git-service';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { FetchHandler } from './FetchHandler';
import type { FetchLimits } from './FetchHandler';
import { PushHandler } from './PushHandler';
import { ReadModelService } from './ReadModelService';

// NOTE: intentionally still extends the real `DurableObject` rather than
// `AbstractDurableObjectWorker` (see return notes): the abstract base does
// not extend `cloudflare:workers` DurableObject (Layer 1 must typecheck
// without it), so subclassing it would strip workerd DO semantics (storage
// isolation, getByName routing, RPC entrypoints). Its ctx type
// (`DurableObjectStateLike` with `storage?: unknown`) is also incompatible
// with `new DofsFs(ctx, ...)` and the `ctx.storage.get/put/deleteAll` calls
// below. Same applies to CronTasksWorker.
class RepoWorker extends DurableObject<Env> {
  private readonly dofs: DofsFs;
  private readonly isoGitFs: ReturnType<IsoGitFs['getPromiseFsClient']>;
  private readonly git: GitService;
  private readonly fetchHandler: FetchHandler;
  private readonly pushHandler: PushHandler;
  private readonly readModel: ReadModelService;

  private fullNameValue: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.dofs = new DofsFs(ctx, env, { chunkSize: 512 * 1024 });

    this.isoGitFs = new IsoGitFs(this.dofs).getPromiseFsClient();
    this.git = new GitService(this.isoGitFs, '/repo');
    this.fetchHandler = new FetchHandler({ git: this.git, env, getFullName: () => this.fullNameValue });
    this.pushHandler = new PushHandler({ isoGitFs: this.isoGitFs, git: this.git, getFullName: () => this.fullNameValue });
    this.readModel = new ReadModelService(this.git);

    // NOTE: Do NOT call blockConcurrencyWhile here. `new Fs()` already
    // schedules its own blockConcurrencyWhile(ensureSchema). Nesting a second
    // block that runs isomorphic-git init deadlocks (30s timeout → DO reset →
    // HTTP 500 on every POST git-upload-pack / receive-pack advertise).
    // Repo init is lazy via ensureRepoInitialized() on each entrypoint.
  }

  private async loadFullNameIfNeeded(): Promise<void> {
    if (this.fullNameValue) return;
    try {
      const stored = await this.ctx.storage.get<string>('fullName');
      if (stored) this.fullNameValue = stored;
    } catch {
      // storage may be unavailable during early init; callers handle missing name
    }
  }

  private ensureDeviceSize(): void {
    try {
      this.dofs.setDeviceSize(5 * 1024 * 1024 * 1024);
    } catch {
      // ENOSPC / already set — safe to ignore, write path surfaces real errors
    }
  }

  public get fullName(): string {
    if (!this.fullNameValue) {
      throw new Error('Repository full name is not set');
    }
    return this.fullNameValue;
  }

  public async setFullName(fullName: string): Promise<void> {
    if (this.fullNameValue) return;
    this.fullNameValue = fullName;
    await this.ctx.storage.put('fullName', fullName);
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/git-receive-pack' && request.method === 'POST') {
      await this.loadFullNameIfNeeded();
      this.ensureDeviceSize();
      await this.ensureRepoInitialized();
      const data = new Uint8Array(await request.arrayBuffer());
      return this.receivePack(data);
    }

    if (pathname === '/git-upload-pack' && request.method === 'POST') {
      await this.loadFullNameIfNeeded();
      this.ensureDeviceSize();
      await this.ensureRepoInitialized();
      const data = new Uint8Array(await request.arrayBuffer());
      return this.uploadPack(data);
    }

    if (pathname === '/ensure' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { fullName?: string };
      if (body.fullName) {
        await this.setFullName(body.fullName);
      }
      this.ensureDeviceSize();
      await this.ensureRepoInitialized();
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
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

  public async listRefs(): Promise<{ refs: Array<{ ref: string; oid: string }>; symbolicHead: string | null }> {
    await this.prepare();
    return this.git.listRefs();
  }

  private async prepare(): Promise<void> {
    await this.loadFullNameIfNeeded();
    this.ensureDeviceSize();
    await this.ensureRepoInitialized();
    this.git.ensureFreshCache(ConfigurationManager.repo.getCacheTtlSeconds(this.env));
  }

  private getLimits(): FetchLimits & { maxCommands: number } {
    return {
      maxWants: ConfigurationManager.repo.getMaxFetchWants(this.env),
      maxHaves: ConfigurationManager.repo.getMaxFetchHaves(this.env),
      maxCommands: ConfigurationManager.repo.getMaxPushCommands(this.env),
      maxObjects: ConfigurationManager.repo.getMaxPackObjects(this.env),
      maxPackBytes: ConfigurationManager.repo.getMaxPackBytes(this.env),
      maxFetchBodyBytes: ConfigurationManager.repo.getMaxFetchBodyBytes(this.env),
    };
  }

  public async receivePack(data: Uint8Array): Promise<Response> {
    return this.pushHandler.receivePack(data, this.getLimits());
  }

  public async uploadPack(data: Uint8Array): Promise<Response> {
    return this.fetchHandler.uploadPack(data, this.getLimits());
  }

  public async getLatestCommit(branch = 'HEAD'): Promise<unknown> {
    await this.prepare();
    return this.readModel.getLatestCommit(branch);
  }

  public async getCommits(args: { ref?: string; depth?: number; filepath?: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getCommits(args);
  }

  public async getBranches(): Promise<{ branches: string[]; currentBranch: string | null }> {
    await this.prepare();
    return this.readModel.getBranches();
  }

  public async getTree(args: { ref?: string; path?: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getTree(args);
  }

  public async getBlob(args: { ref?: string; filepath: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getBlob(args);
  }

  public async getCommit(commitOid: string): Promise<unknown> {
    await this.prepare();
    return this.readModel.getCommit(commitOid);
  }
}

export { RepoWorker };
