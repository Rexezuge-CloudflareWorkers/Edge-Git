import type { IsoGitFs } from './IsoGitFs';
import type { RefUpdateResult } from '@edge-git/git-protocol';
import { RefService } from './RefService';
import { ObjectReader } from './ObjectReader';
import { PackCollector } from './PackCollector';
import { HistoryService } from './HistoryService';

export { PackLimitError } from './PackCollector';

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

export class GitService {
  private readonly fs: PromiseFsClient;
  private readonly gitdir: string;
  private readonly refs: RefService;
  private readonly objects: ObjectReader;
  private readonly packs: PackCollector;
  private readonly history: HistoryService;

  private cache: object = {};
  private cacheCreatedAt = Date.now();

  constructor(fs: PromiseFsClient, gitdir: string) {
    this.fs = fs;
    this.gitdir = gitdir;
    this.refs = new RefService(fs, gitdir);
    this.objects = new ObjectReader(fs, gitdir);
    this.packs = new PackCollector(fs, gitdir);
    this.history = new HistoryService(fs, gitdir);
  }

  public clearCache(): void {
    this.cache = {};
    this.cacheCreatedAt = Date.now();
    this.objects.clearCache();
    this.packs.clearCache();
    this.history.clearCache();
  }

  public ensureFreshCache(ttlSeconds: number): void {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
    if (Date.now() - this.cacheCreatedAt > ttlSeconds * 1000) {
      this.clearCache();
    }
  }

  async initRepo() {
    return this.refs.initRepo();
  }

  async listRefs() {
    return this.refs.listRefs();
  }

  async listBranchesWithOid(): Promise<Array<{ ref: string; oid: string }>> {
    return this.refs.listBranchesWithOid();
  }

  async listBranches() {
    return this.refs.listBranches();
  }

  async currentBranch() {
    return this.refs.currentBranch();
  }

  async listTags(): Promise<Array<{ ref: string; oid: string }>> {
    return this.refs.listTags();
  }

  async readObject(oid: string) {
    return this.objects.readObject(oid);
  }

  async readObjectForLsRefs(oid: string) {
    return this.objects.readObjectForLsRefs(oid);
  }

  async expandRef(ref: string) {
    return this.objects.expandRef(ref);
  }

  async peelTag(tagOid: string): Promise<string | null> {
    return this.objects.peelTag(tagOid);
  }

  async indexPack(filePath: string) {
    return this.packs.indexPack(filePath);
  }

  async collectObjectsForPack(
    wants: string[],
    haves: string[],
    opts: { depth?: number; since?: number; exclude?: string[]; filter?: string; maxObjects?: number } = {},
  ): Promise<{ oids: string[]; shallow: string[] }> {
    return this.packs.collectObjectsForPack(wants, haves, opts);
  }

  async packObjects(oids: string[]) {
    return this.packs.packObjects(oids);
  }

  async hasObject(oid: string): Promise<boolean> {
    return this.objects.hasObject(oid);
  }

  async findCommonCommits(haves: string[], maxHaves?: number): Promise<string[]> {
    return this.packs.findCommonCommits(haves, maxHaves);
  }

  async getLastCommit(branch: string) {
    return this.history.getLastCommit(branch);
  }

  async getLog({ ref, depth, filepath }: { ref?: string; depth?: number; filepath?: string }) {
    return this.history.getLog({ ref, depth, filepath });
  }

  async resolveRef(ref = 'HEAD') {
    return this.refs.resolveRef(ref);
  }

  async getTree(resolvedRef: string, path = '') {
    return this.history.getTree(resolvedRef, path);
  }

  async getBlob(resolvedRef: string, filepath: string) {
    return this.history.getBlob(resolvedRef, filepath);
  }

  getBlobSize(content: Uint8Array): number {
    return this.history.getBlobSize(content);
  }

  detectBinary(content: Uint8Array): boolean {
    return this.history.detectBinary(content);
  }

  async getFileStateChanges(oldCommit: string | undefined, newCommit: string | undefined) {
    return this.history.getFileStateChanges(oldCommit, newCommit);
  }

  async getCommit(commitOid: string) {
    return this.history.getCommit(commitOid);
  }

  async applyRefUpdates(commands: Array<{ oldOid: string; newOid: string; ref: string }>, atomic: boolean): Promise<RefUpdateResult[]> {
    return this.refs.applyRefUpdates(commands, atomic);
  }
}
