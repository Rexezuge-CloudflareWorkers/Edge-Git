import { DurableObject } from 'cloudflare:workers';
import { DofsFs, GitService, IsoGitFs, PackLimitError } from '@edge-git/git-service';
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

  public async createBranch(args: { name: string; fromRef?: string }): Promise<unknown> {
    await this.prepare();
    const startOid = await this.git.resolveRef(args.fromRef || 'HEAD');
    if (!startOid) {
      return { ok: false, error: 'unknown start point', status: 404 };
    }
    const result = await this.git.createBranch(args.name, startOid);
    if (result.ok) this.git.clearCache();
    return result;
  }

  public async deleteBranchRef(branch: string): Promise<unknown> {
    await this.prepare();
    const result = await this.git.deleteBranchRef(branch);
    if (result.ok) this.git.clearCache();
    return result;
  }

  /**
   * Commit a single file create/update/delete on a branch (web editor).
   * `content: null` deletes. Returns a discriminated union — never throws
   * except for oversized packs — so it survives DO RPC boundaries.
   */
  public async commitFile(args: {
    branch: string;
    path: string;
    content: Uint8Array | null;
    message?: string;
    expectedOid?: string | null;
    authorName: string;
    authorEmail: string;
  }): Promise<unknown> {
    await this.prepare();
    const result = await this.git.commitFile({
      branch: args.branch,
      path: args.path,
      content: args.content,
      message: args.message,
      expectedOid: args.expectedOid,
      author: { name: args.authorName, email: args.authorEmail },
      maxFileBytes: ConfigurationManager.repo.getMaxFileBytes(this.env),
    });
    if (result.ok) this.git.clearCache();
    return result;
  }

  public async setDefaultBranch(branch: string): Promise<unknown> {
    await this.prepare();
    const result = await this.git.setDefaultBranch(branch);
    if (result.ok) this.git.clearCache();
    return result;
  }

  public async getTags(): Promise<
    Array<{ name: string; ref: string; oid: string; peeledOid: string | null; type: 'lightweight' | 'annotated' }>
  > {
    await this.prepare();
    return this.readModel.getTags();
  }

  public async getTree(args: { ref?: string; path?: string; withLastCommit?: boolean }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getTree(args);
  }

  public async getBlob(args: { ref?: string; filepath: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getBlob(args);
  }

  public async getOverview(args: {
    ref?: string;
    path?: string;
    depth?: number;
    includeTags?: boolean;
    includeReadme?: boolean;
  }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getOverview(args);
  }

  public async listAllFiles(args: { ref?: string; maxFiles?: number }): Promise<Array<{ path: string; oid: string }>> {
    await this.prepare();
    return this.readModel.listAllFiles(args);
  }

  public async getCommit(commitOid: string): Promise<unknown> {
    await this.prepare();
    return this.readModel.getCommit(commitOid);
  }

  public async getCommitDiff(commitOid: string): Promise<unknown> {
    await this.prepare();
    return this.readModel.getCommitDiff(commitOid, ConfigurationManager.repo.getMaxMergeDiffFiles(this.env));
  }

  public async getCompare(args: { baseRef: string; headRef: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getCompare(args.baseRef, args.headRef, ConfigurationManager.repo.getMaxMergeDiffFiles(this.env));
  }

  public async getMergePreview(args: { baseRef: string; headRef: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getMergePreview(args.baseRef, args.headRef);
  }

  public async getMergePreviewByOids(args: { baseOid: string; headOid: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getMergePreviewByOids(args.baseOid, args.headOid);
  }

  public async resolveRef(ref: string): Promise<string | null> {
    await this.prepare();
    return this.git.resolveRef(ref);
  }

  public async hasObject(oid: string): Promise<boolean> {
    await this.prepare();
    return this.git.hasObject(oid);
  }

  /**
   * Export a packfile for the given wants (fork copy, cross-fork PR
   * materialization). Bounded by the repo pack limits; over-limit exports
   * throw `PackLimitError` so callers fail closed.
   */
  public async exportPack(wants: string[]): Promise<{ oids: string[]; pack: Uint8Array | null }> {
    await this.prepare();
    if (wants.length === 0) return { oids: [], pack: null };
    const limits = this.getLimits();
    const { oids } = await this.git.collectObjectsForPack(wants, [], { maxObjects: limits.maxObjects });
    if (oids.length === 0) return { oids, pack: null };
    const pack = (await this.git.packObjects(oids)) as Uint8Array | undefined;
    if (!pack || pack.byteLength === 0) return { oids, pack: null };
    if (pack.byteLength > limits.maxPackBytes) {
      throw new PackLimitError(`pack too large: ${pack.byteLength} > ${limits.maxPackBytes} bytes`);
    }
    return { oids, pack };
  }

  /**
   * Index an exported packfile into this repo. When `refs` are provided
   * (fork copy), missing refs are created; otherwise (cross-fork PR
   * materialization) only objects are imported and no refs are touched.
   */
  public async importPack(pack: Uint8Array, refs?: Array<{ ref: string; oid: string }>): Promise<{ importedRefs: string[] }> {
    await this.prepare();
    if (!pack || pack.byteLength === 0) return { importedRefs: [] };
    const limits = this.getLimits();
    if (pack.byteLength > limits.maxPackBytes) {
      throw new PackLimitError(`pack too large: ${pack.byteLength} > ${limits.maxPackBytes} bytes`);
    }
    const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const packFilePath = `/repo/objects/pack/fork-${suffix}.pack`;
    let wrotePack = false;
    try {
      await this.isoGitFs.promises.writeFile(packFilePath, pack);
      wrotePack = true;
      await this.git.indexPack(packFilePath.replace('/repo/', ''));
    } catch (error) {
      if (wrotePack) {
        await this.isoGitFs.promises.unlink(packFilePath).catch(() => undefined);
      }
      throw error;
    }
    this.git.clearCache();
    const importedRefs: string[] = [];
    const pending = (refs ?? []).filter((r) => typeof r.ref === 'string' && /^[0-9a-f]{40}$/.test(r.oid));
    if (pending.length > 0) {
      const results = await this.git.applyRefUpdates(
        pending.map((r) => ({ oldOid: '0'.repeat(40), newOid: r.oid, ref: r.ref })),
        false,
      );
      for (const [i, result] of results.entries()) {
        if (result.ok) importedRefs.push(pending[i].ref);
      }
      this.git.clearCache();
    }
    return { importedRefs };
  }

  public async getPullDiff(args: { baseOid: string | null; headOid: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getPullDiff(args.baseOid, args.headOid, ConfigurationManager.repo.getMaxMergeDiffFiles(this.env));
  }

  public async mergePull(args: {
    baseBranch: string;
    headBranch?: string;
    headOid: string;
    authorName: string;
    authorEmail: string;
    message?: string;
    deleteHead?: boolean;
  }): Promise<unknown> {
    await this.prepare();
    const outcome = await this.git.mergeBranches({
      baseBranch: args.baseBranch,
      headOid: args.headOid,
      author: { name: args.authorName, email: args.authorEmail },
      message: args.message,
    });
    if (outcome.type !== 'conflict') {
      this.git.clearCache();
    }
    let deletedHead = false;
    if (args.deleteHead && outcome.type !== 'conflict' && args.headBranch && args.headBranch !== args.baseBranch) {
      try {
        await this.git.deleteBranch(args.headBranch);
        deletedHead = true;
        this.git.clearCache();
      } catch {
        // Best-effort: head may already be gone or checked out. Merge still counts.
        deletedHead = false;
      }
    }
    return { ...outcome, deletedHead };
  }

  /**
   * Delete a branch in this repo (cross-fork PR `deleteHead` targets the
   * head repo DO). Best-effort: missing/invalid branches report
   * `deleted: false` instead of throwing.
   */
  public async deleteBranch(branch: string): Promise<{ deleted: boolean }> {
    await this.prepare();
    try {
      await this.git.deleteBranch(branch);
      this.git.clearCache();
      return { deleted: true };
    } catch {
      return { deleted: false };
    }
  }
}

export { RepoWorker };
