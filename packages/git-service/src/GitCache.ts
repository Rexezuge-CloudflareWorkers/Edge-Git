/**
 * Shared isomorphic-git cache mixin (Otter pure-helper pattern).
 * Deduplicates `clearCache/ensureFreshCache` previously copy-pasted across
 * `GitService`, `HistoryService`, `PackCollector`, and `MergeService`.
 */
class GitCache {
  private cache: object = {};
  private cacheCreatedAt = Date.now();

  public getCache(): object {
    return this.cache;
  }

  public setCache(cache: object): void {
    this.cache = cache;
  }

  public clearCache(): void {
    this.cache = {};
    this.cacheCreatedAt = Date.now();
  }

  public ensureFreshCache(ttlSeconds: number): void {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
    if (Date.now() - this.cacheCreatedAt > ttlSeconds * 1000) {
      this.clearCache();
    }
  }
}

export { GitCache };
