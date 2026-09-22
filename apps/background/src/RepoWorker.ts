import { DurableObject } from 'cloudflare:workers';
import type { DofsFs } from '@edge-git/git-service';
import type { IsoGitFs } from '@edge-git/git-service';
import type { GitService } from '@edge-git/git-service';
import type { ProtectedRefRule } from '@edge-git/git-protocol';
import type { AppConfiguration } from '@edge-git/backend-runtime/config';
import type { FetchHandler } from './FetchHandler';
import type { PushHandler } from './PushHandler';
import type { ReadModelService } from './ReadModelService';
import type { ReleaseAssetStore } from './ReleaseAssetStore';
import type { RepoLifecycle } from './RepoLifecycle';
import type { RepoReadRpc } from './RepoReadRpc';
import { createRepoWorkerDeps } from './RepoWorkerFactory';
import { RepoFullName, repoDoKeyForFullName } from '@edge-git/shared/utils';

// NOTE: intentionally still extends the real `DurableObject` rather than
// `AbstractDurableObjectWorker` (see return notes): the abstract base does
// not extend `cloudflare:workers` DurableObject (Layer 1 must typecheck
// without it), so subclassing it would strip workerd DO semantics (storage
// isolation, getByName routing, RPC entrypoints). Its ctx type
// (`DurableObjectStateLike` with `storage?: unknown`) is also incompatible
// with `createDofsFs(ctx, ...)` and the `ctx.storage.get/put/deleteAll` calls
// below. Same applies to CronTasksWorker.
//
// Facade (Otter pattern): routing + composition only. Lifecycle lives in
// `RepoLifecycle`, read-model RPC fan-out in `RepoReadRpc`, pack handling in
// `FetchHandler`/`PushHandler`. Previously 491 LOC; now under the 300 LOC
// soft god-file guard.
class RepoWorker extends DurableObject<Env> {
  private readonly dofs: DofsFs;
  private readonly isoGitFs: ReturnType<IsoGitFs['getPromiseFsClient']>;
  private readonly git: GitService;
  private readonly fetchHandler: FetchHandler;
  private readonly pushHandler: PushHandler;
  private readonly readModel: ReadModelService;
  private readonly releaseAssets: ReleaseAssetStore;
  private readonly lifecycle: RepoLifecycle;
  private readonly reads: RepoReadRpc;
  private readonly config: AppConfiguration;

  private fullNameValue: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const deps = createRepoWorkerDeps(ctx, env, {
      getFullName: () => this.fullNameValue,
      loadFullName: () => this.loadFullNameIfNeeded(),
      prepare: () => this.prepare(),
    });
    this.dofs = deps.dofs;
    this.isoGitFs = deps.isoGitFs;
    this.git = deps.git;
    this.config = deps.config;
    this.fetchHandler = deps.fetchHandler;
    this.pushHandler = deps.pushHandler;
    this.readModel = deps.readModel;
    this.releaseAssets = deps.releaseAssets;
    this.lifecycle = deps.lifecycle;
    this.reads = deps.reads;

    // NOTE: Do NOT call blockConcurrencyWhile here. `createDofsFs()` already
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
    this.lifecycle.ensureDeviceSize();
  }

  public get fullName(): string {
    if (!this.fullNameValue) {
      throw new Error('Repository full name is not set');
    }
    return this.fullNameValue;
  }

  public async setFullName(fullName: string): Promise<void> {
    // BREAKING: display-case is updated when the canonical DO key changes
    // (rename or case-correction). The old first-writer-wins guard ignored
    // renames and left `ctx.storage.fullName` drifting from D1.
    if (this.fullNameValue === fullName) return;
    const { owner, name } = splitFullName(fullName);
    if (!owner || !name || !RepoFullName.tryParse(owner, name)) throw new Error('Invalid repository full name');
    const previousKey = this.fullNameValue ? repoDoKeyForFullName(this.fullNameValue) : null;
    this.fullNameValue = fullName;
    await this.ctx.storage.put('fullName', fullName);
    // A rename onto this isolate must not serve the previous repo's refs.
    if (previousKey !== null && previousKey !== repoDoKeyForFullName(fullName)) {
      this.git.clearCache();
    }
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
      if (typeof body.fullName === 'string' && body.fullName) {
        const { owner, name } = splitFullName(body.fullName);
        if (!owner || !name || !RepoFullName.tryParse(owner, name)) {
          return new Response('Invalid fullName', { status: 400 });
        }
        await this.setFullName(body.fullName);
      }
      this.ensureDeviceSize();
      await this.ensureRepoInitialized();
      return Response.json({ ok: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  public async initRepo(): Promise<void> {
    await this.lifecycle.initRepo();
  }

  public async deleteRepo(): Promise<void> {
    await this.lifecycle.deleteRepo();
    // The name binding is gone from storage: drop the in-memory guard too so
    // a later recreate of the same name re-persists it via `setFullName`.
    this.fullNameValue = undefined;
  }

  public async ensureRepoInitialized(): Promise<void> {
    await this.lifecycle.ensureRepoInitialized();
  }

  public async listRefs(): Promise<{ refs: Array<{ ref: string; oid: string }>; symbolicHead: string | null }> {
    await this.prepare();
    return this.git.listRefs();
  }

  private async prepare(): Promise<void> {
    await this.lifecycle.prepare();
  }

  private getLimits(): ReturnType<RepoLifecycle['getLimits']> {
    return this.lifecycle.getLimits();
  }

  public async receivePack(data: Uint8Array, protections: ProtectedRefRule[] = []): Promise<Response> {
    return this.pushHandler.receivePack(data, this.getLimits(), protections);
  }

  public async uploadPack(data: Uint8Array): Promise<Response> {
    return this.fetchHandler.uploadPack(data, this.getLimits());
  }

  public async getLatestCommit(branch = 'HEAD'): Promise<unknown> {
    return this.reads.getLatestCommit(branch);
  }

  public async getCommits(args: { ref?: string; depth?: number; filepath?: string }): Promise<unknown> {
    return this.reads.getCommits(args);
  }

  public async getBranches(): Promise<{ branches: string[]; currentBranch: string | null }> {
    return this.reads.getBranches();
  }

  public async createBranch(args: { name: string; fromRef?: string }): Promise<unknown> {
    return this.reads.createBranch(args);
  }

  public async deleteBranchRef(branch: string): Promise<unknown> {
    return this.reads.deleteBranchRef(branch);
  }

  public async commitFile(args: {
    branch: string;
    path: string;
    content: Uint8Array | null;
    message?: string;
    expectedOid?: string | null;
    authorName: string;
    authorEmail: string;
  }): Promise<unknown> {
    return this.reads.commitFile(args);
  }

  public async setDefaultBranch(branch: string): Promise<unknown> {
    return this.reads.setDefaultBranch(branch);
  }

  public async getTags(): Promise<
    Array<{ name: string; ref: string; oid: string; peeledOid: string | null; type: 'lightweight' | 'annotated' }>
  > {
    return this.reads.getTags();
  }

  public async getTree(args: { ref?: string; path?: string; withLastCommit?: boolean }): Promise<unknown> {
    return this.reads.getTree(args);
  }

  public async getBlob(args: { ref?: string; filepath: string }): Promise<unknown> {
    return this.reads.getBlob(args);
  }

  public async getOverview(args: {
    ref?: string;
    path?: string;
    depth?: number;
    includeTags?: boolean;
    includeReadme?: boolean;
  }): Promise<unknown> {
    return this.reads.getOverview(args);
  }

  public async listAllFiles(args: { ref?: string; maxFiles?: number }): Promise<Array<{ path: string; oid: string }>> {
    return this.reads.listAllFiles(args);
  }

  public async getCommit(commitOid: string): Promise<unknown> {
    return this.reads.getCommit(commitOid);
  }

  public async getCommitDiff(commitOid: string): Promise<unknown> {
    return this.reads.getCommitDiff(commitOid);
  }

  public async getCompare(args: { baseRef: string; headRef: string }): Promise<unknown> {
    return this.reads.getCompare(args);
  }

  public async getMergePreview(args: { baseRef: string; headRef: string }): Promise<unknown> {
    return this.reads.getMergePreview(args);
  }

  public async getMergePreviewByOids(args: { baseOid: string; headOid: string }): Promise<unknown> {
    return this.reads.getMergePreviewByOids(args);
  }

  public async resolveRef(ref: string): Promise<string | null> {
    return this.reads.resolveRef(ref);
  }

  public async hasObject(oid: string): Promise<boolean> {
    return this.reads.hasObject(oid);
  }

  public async isAncestor(ancestor: string, oid: string): Promise<boolean> {
    return this.reads.isAncestor(ancestor, oid);
  }

  public async updateRefs(updates: Array<{ ref: string; oldOid: string; newOid: string }>): Promise<unknown> {
    return this.reads.updateRefs(updates);
  }

  public async exportPack(wants: string[]): Promise<{ oids: string[]; pack: Uint8Array | null }> {
    return this.reads.exportPack(wants);
  }

  public async importPack(pack: Uint8Array, refs?: Array<{ ref: string; oid: string }>): Promise<{ importedRefs: string[] }> {
    return this.reads.importPack(pack, refs);
  }

  public async getPullDiff(args: { baseOid: string | null; headOid: string }): Promise<unknown> {
    return this.reads.getPullDiff(args);
  }

  public async mergePull(args: {
    baseBranch: string;
    headBranch?: string;
    headOid: string;
    authorName: string;
    authorEmail: string;
    message?: string;
    deleteHead?: boolean;
    strategy?: 'merge' | 'squash' | 'rebase';
  }): Promise<unknown> {
    return this.reads.mergePull(args);
  }

  public async deleteBranch(branch: string): Promise<{ deleted: boolean }> {
    return this.reads.deleteBranch(branch);
  }

  public async getBlame(args: { ref?: string; filepath: string }): Promise<unknown> {
    return this.reads.getBlame(args);
  }

  public async storeReleaseAsset(args: { releaseId: string; assetId: string; bytes: Uint8Array }): Promise<unknown> {
    return this.reads.storeReleaseAsset(args);
  }

  public async getReleaseAsset(args: { releaseId: string; assetId: string }): Promise<Uint8Array | null> {
    return this.reads.getReleaseAsset(args);
  }

  public async deleteReleaseAsset(args: { releaseId: string; assetId: string }): Promise<{ deleted: boolean }> {
    return this.reads.deleteReleaseAsset(args);
  }

  public async deleteReleaseAssets(args: { releaseId: string }): Promise<{ deleted: number }> {
    return this.reads.deleteReleaseAssets(args);
  }
}

export { RepoWorker };

// Single `owner/name[/...]` split shared by `setFullName` and the `/ensure`
// fetch entrypoint (Value Object construction stays in `RepoFullName`).
function splitFullName(fullName: string): { owner: string; name: string } {
  const [owner = '', ...rest] = fullName.split('/');
  return { owner, name: rest.join('/') };
}
