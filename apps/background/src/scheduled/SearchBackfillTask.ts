import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { createLogger } from '@edge-git/backend-runtime/logger';
import type { SearchService } from '@edge-git/backend-services/search';
import { BaseScheduledTask } from './IScheduledTask';

const logger = createLogger('SearchBackfill');

const MAX_INDEX_BYTES = 20_000;

interface IndexedBlob {
  contentBase64?: string;
  isBinary?: boolean;
}

function decodeBlobToText(blob: IndexedBlob | null): string | null {
  if (!blob?.contentBase64 || blob.isBinary) return null;
  try {
    const binary = atob(blob.contentBase64);
    if (binary.length > MAX_INDEX_BYTES) return null;
    const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// Push catch-up for the code search index. Web file writes index
// synchronously (FileWriteRoutes); `git push` paths have no D1 access inside
// the RepoWorker DO, so this cron task re-indexes HEAD contents.
//
// D1 rows-read discipline (5M/day budget): the index upsert used to rewrite
// every file every tick (~250 rows-read per file via FTS churn). This task
// now compares live HEAD blob oids against indexed oids and only fetches +
// writes changed files, batches writes per repo, and purges paths deleted
// from HEAD. Unchanged repos cost one cheap oid-map read and zero writes.
//
// NOTE: staleness is driven by blob oids from git, never by
// `repositories.updated_at` — pushes do not bump that column (the DO has no
// D1 access), so an updated_at watermark would skip freshly pushed repos
// forever. Eventual consistency is ~1 search tick (4h; see TaskRegistry).
class SearchBackfillTask extends BaseScheduledTask {
  public readonly name = 'SearchBackfillTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const scope = createRequestScope(env);
    const repositoryDAO = await scope.get(Tokens.RepositoryDAO)();
    const search = scope.get(Tokens.SearchService);
    const maxRepos = ConfigurationManager.processing.getSearchBackfillReposPerTick(env);
    const maxFiles = ConfigurationManager.processing.getSearchBackfillFilesPerRepo(env);
    let repos: Array<{ id: string; owner: string; name: string }>;
    try {
      repos = await repositoryDAO.listRecent(maxRepos, 0);
    } catch (error) {
      logger.error('Search backfill: failed to list repos', error);
      return;
    }
    let indexed = 0;
    let skipped = 0;
    for (const repo of repos) {
      try {
        const result = await this.indexRepo(env, search, repo, maxFiles);
        indexed += result.indexed;
        skipped += result.skipped;
      } catch (error) {
        logger.error(`Search backfill: failed for repo ${repo.owner}/${repo.name}`, error);
      }
    }
    if (indexed > 0 || skipped > 0) {
      logger.info(`Search backfill indexed ${indexed} files, skipped ${skipped} unchanged across ${repos.length} repos`);
    }
  }

  private async indexRepo(
    env: Env,
    search: SearchService,
    repo: { id: string; owner: string; name: string },
    maxFiles: number,
  ): Promise<{ indexed: number; skipped: number }> {
    const stub = env.REPO.getByName(`${repo.owner}/${repo.name}`) as unknown as {
      listAllFiles(args: { maxFiles?: number }): Promise<Array<{ path: string; oid: string }>>;
      getBlob(args: { filepath: string }): Promise<IndexedBlob | null>;
    };
    let files: Array<{ path: string; oid: string }>;
    try {
      files = await stub.listAllFiles({ maxFiles });
    } catch {
      return { indexed: 0, skipped: 0 };
    }
    const head = files.slice(0, maxFiles);
    const keepPaths = head.map((file) => file.path);
    let indexedOids: Map<string, string | null>;
    try {
      indexedOids = await search.getIndexedOids(repo.id);
    } catch {
      indexedOids = new Map();
    }
    const pending: Array<{ repoId: string; path: string; oid: string | null; content: string }> = [];
    let skipped = 0;
    for (const file of head) {
      // Unchanged blob: skip the blob fetch and the D1 upsert entirely.
      if (indexedOids.get(file.path) === file.oid) {
        skipped += 1;
        continue;
      }
      try {
        const blob = await stub.getBlob({ filepath: file.path }).catch(() => null);
        const text = decodeBlobToText(blob);
        if (text === null) continue;
        pending.push({ repoId: repo.id, path: file.path, oid: file.oid, content: text });
      } catch (error) {
        logger.error(`Search backfill: failed to index ${repo.owner}/${repo.name}:${file.path}`, error);
      }
    }
    let indexed = 0;
    if (pending.length > 0) {
      try {
        indexed = await search.indexFiles(pending);
      } catch (error) {
        logger.error(`Search backfill: failed to write index for repo ${repo.owner}/${repo.name}`, error);
      }
    }
    // Purge paths deleted from HEAD. The listing above succeeded, so an
    // empty keepPaths genuinely means an empty repo — safe to clear.
    try {
      await search.purgeStalePaths(repo.id, keepPaths);
    } catch (error) {
      logger.error(`Search backfill: failed to purge stale paths for repo ${repo.owner}/${repo.name}`, error);
    }
    return { indexed, skipped };
  }
}

export { SearchBackfillTask };
