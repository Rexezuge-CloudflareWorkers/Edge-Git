import { DurableObject } from 'cloudflare:workers';
import { DofsFs, GitService, IsoGitFs } from '@edge-git/git-service';
import {
  buildFetchResponse,
  buildLsRefsResponse,
  buildReportStatus,
  parseCommand,
  parseFetchRequest,
  parseReceivePackRequest,
  shouldSendPackfileForFetch,
} from '@edge-git/git-protocol';
import { createLogger } from '@edge-git/backend-runtime/logger';

const logger = createLogger('RepoWorker');

class RepoWorker extends DurableObject<Env> {
  private readonly dofs: DofsFs;
  private readonly isoGitFs: ReturnType<IsoGitFs['getPromiseFsClient']>;
  private readonly git: GitService;

  private fullNameValue: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.dofs = new DofsFs(ctx, env, { chunkSize: 512 * 1024 });

    this.isoGitFs = new IsoGitFs(this.dofs).getPromiseFsClient();
    this.git = new GitService(this.isoGitFs, '/repo');

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
  }

  public async receivePack(data: Uint8Array): Promise<Response> {
    const { commands, packfile, capabilities } = parseReceivePackRequest(data);

    if (commands.length === 0) {
      return buildReportStatus([{ ref: '*', ok: false, error: 'no commands' }], false);
    }

    const packFilePath = `/repo/objects/pack/pack-${Date.now()}.pack`;
    await this.isoGitFs.promises.writeFile(packFilePath, packfile);

    try {
      await this.git.indexPack(packFilePath.replace('/repo/', ''));
    } catch (error) {
      logger.error('(receive-pack) Failed to index packfile: ', error);
      return buildReportStatus(
        [
          {
            ref: '*',
            ok: false,
            error: `unpack failed: ${(error as Error).message}`,
          },
        ],
        false,
      );
    }

    const atomic = capabilities.includes('atomic');
    const results = await this.git.applyRefUpdates(commands, atomic);

    return buildReportStatus(results, true);
  }

  public async uploadPack(data: Uint8Array): Promise<Response> {
    const { command, args } = parseCommand(data);

    if (command === 'ls-refs') {
      const { refs, symbolicHead } = await this.git.listRefs();

      return buildLsRefsResponse(refs, args, symbolicHead, async (oid: string) => this.git.readObjectForLsRefs(oid));
    }

    if (command === 'fetch') {
      const fetchRequest = parseFetchRequest(data, args);

      if (fetchRequest.wants.length === 0) {
        return buildFetchResponse({
          commonCommits: [],
          packfileData: null,
          noProgress: true,
          done: fetchRequest.done,
        });
      }

      const commonCommits = await this.git.findCommonCommits(fetchRequest.haves);

      // wait-for-done: never send ready/packfile until the client says done.
      // Otherwise (classic stateless negotiation) send ACK+ready+packfile in the
      // same response as soon as a common base exists (or for clones).
      const shouldSendPackfile = shouldSendPackfileForFetch(fetchRequest, commonCommits);

      let packfileData: Uint8Array | undefined | null = null;
      let shallow: string[] = [];
      const unshallow: string[] = [];

      if (shouldSendPackfile) {
        try {
          // deepen-not entries may be ref names; resolve to oids for exclusion.
          const excludeOids: string[] = [];
          const deepenNot = fetchRequest.shallowOptions?.deepenNot ?? [];
          for (const entry of deepenNot) {
            const resolved = await this.git.resolveRef(entry);
            excludeOids.push(resolved ?? entry);
          }

          const rawDepth = fetchRequest.shallowOptions?.deepen;
          const depth = rawDepth !== undefined && Number.isFinite(rawDepth) && rawDepth > 0 ? Math.trunc(rawDepth) : undefined;
          const since = fetchRequest.shallowOptions?.deepenSince;
          const { oids, shallow: boundary } = await this.git.collectObjectsForPack(fetchRequest.wants, fetchRequest.haves, {
            depth,
            since,
            exclude: excludeOids,
            filter: fetchRequest.filterSpec,
          });

          // include-tag: also send annotated tags pointing at packed commits.
          let oidsToPack = oids;
          if (fetchRequest.capabilities.includeTag) {
            oidsToPack = await this.expandWithTags(oidsToPack);
          }

          logger.info(`(upload-pack-fetch) Packing ${oidsToPack.length} objects for wants: ${fetchRequest.wants.join(', ')}`);

          packfileData = await this.git.packObjects(oidsToPack);
          if (depth !== undefined || since !== undefined) {
            shallow = boundary;
            // Client-sent shallow lines now fulfilled are unshallowed.
            const clientShallow = fetchRequest.shallowOptions?.shallow ?? [];
            for (const s of clientShallow) {
              if (!shallow.includes(s)) unshallow.push(s);
            }
          }
        } catch (error) {
          logger.error('(upload-pack-fetch) Failed to pack objects: ', error);
          return new Response(`ERR pack-objects failed: ${(error as Error).message}`, { status: 500 });
        }
      }

      return buildFetchResponse({
        commonCommits,
        packfileData,
        noProgress: fetchRequest.capabilities.noProgress,
        done: fetchRequest.done,
        shallow,
        unshallow,
      });
    }

    return new Response('Unsupported command', { status: 400 });
  }

  private async expandWithTags(oids: string[]): Promise<string[]> {
    try {
      const tags = await this.git.listTags();
      const packed = new Set(oids);
      const extra: string[] = [];
      for (const tag of tags) {
        if (packed.has(tag.oid)) continue;
        const target = await this.git.peelTag(tag.oid);
        if (target && packed.has(target)) {
          extra.push(tag.oid);
          packed.add(tag.oid);
        }
      }
      return extra.length > 0 ? [...oids, ...extra] : oids;
    } catch {
      return oids;
    }
  }

  public async getLatestCommit(branch = 'HEAD'): Promise<unknown> {
    await this.prepare();
    return this.git.getLastCommit(branch);
  }

  public async getCommits(args: { ref?: string; depth?: number; filepath?: string }): Promise<unknown> {
    await this.prepare();
    const latestCommit = (await this.git.getLastCommit(args.ref ?? 'HEAD')) as { oid: string } | null;
    if (!latestCommit) {
      return [];
    }
    return this.git.getLog(args);
  }

  public async getBranches(): Promise<{ branches: string[]; currentBranch: string | null }> {
    await this.prepare();
    const branches = await this.git.listBranches();
    const currentBranch = await this.git.currentBranch();
    return { branches, currentBranch: currentBranch ?? null };
  }

  public async getTree(args: { ref?: string; path?: string }): Promise<unknown> {
    await this.prepare();
    const { ref, path } = args;
    const resolvedRef = await this.git.resolveRef(ref);
    if (!resolvedRef) {
      return [];
    }
    const tree = await this.git.getTree(resolvedRef, path);
    const data = await Promise.all(
      (tree as Array<{ path: string }>).map(async (item) => {
        const lastCommit = (await this.git.getLog({
          ref,
          depth: 1,
          filepath: path ? `${path}/${item.path}` : item.path,
        })) as Array<unknown>;
        return { ...item, lastCommit: lastCommit[0] || null };
      }),
    );
    return data;
  }

  public async getBlob(args: { ref?: string; filepath: string }): Promise<unknown> {
    await this.prepare();
    const { ref, filepath } = args;
    const resolvedRef = await this.git.resolveRef(ref);
    if (!resolvedRef) {
      return null;
    }
    const blob = await this.git.getBlob(resolvedRef, filepath);
    if (!blob) return null;
    // Serialize Uint8Array safely as base64
    const content = (blob as { content?: Uint8Array }).content;
    if (content instanceof Uint8Array) {
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < content.length; i += chunk) {
        binary += String.fromCodePoint(...content.subarray(i, i + chunk));
      }
      return { ...(blob as object), contentBase64: btoa(binary) };
    }
    return blob;
  }

  public async getCommit(commitOid: string): Promise<unknown> {
    await this.prepare();
    return this.git.getCommit(commitOid);
  }
}

export { RepoWorker };
