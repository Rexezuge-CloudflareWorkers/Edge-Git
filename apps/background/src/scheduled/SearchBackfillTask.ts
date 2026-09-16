import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { BaseScheduledTask } from './IScheduledTask';

const logger = createLogger('SearchBackfill');

const MAX_REPOS_PER_TICK = 20;
const MAX_FILES_PER_REPO = 50;
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
// the RepoWorker DO, so this cron task re-indexes HEAD contents for the most
// recently updated repos. Eventual consistency is ~1 cron tick (10 min).
class SearchBackfillTask extends BaseScheduledTask {
  public readonly name = 'SearchBackfillTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const scope = createRequestScope(env);
    const repositoryDAO = await scope.get(Tokens.RepositoryDAO)();
    const search = scope.get(Tokens.SearchService);
    let repos: Array<{ id: string; owner: string; name: string }>;
    try {
      repos = await repositoryDAO.listRecent(MAX_REPOS_PER_TICK, 0);
    } catch (error) {
      logger.error('Search backfill: failed to list repos', error);
      return;
    }
    let indexed = 0;
    for (const repo of repos) {
      try {
        indexed += await this.indexRepo(env, search, repo);
      } catch (error) {
        logger.error(`Search backfill: failed for repo ${repo.owner}/${repo.name}`, error);
      }
    }
    if (indexed > 0) logger.info(`Search backfill indexed ${indexed} files across ${repos.length} repos`);
  }

  private async indexRepo(
    env: Env,
    search: { indexFile(input: { repoId: string; path: string; oid: string | null; content: string }): Promise<boolean> },
    repo: { id: string; owner: string; name: string },
  ): Promise<number> {
    const stub = env.REPO.getByName(`${repo.owner}/${repo.name}`) as unknown as {
      listAllFiles(args: { maxFiles?: number }): Promise<Array<{ path: string; oid: string }>>;
      getBlob(args: { filepath: string }): Promise<IndexedBlob | null>;
    };
    const files = await stub.listAllFiles({ maxFiles: MAX_FILES_PER_REPO }).catch(() => []);
    let indexed = 0;
    for (const file of files.slice(0, MAX_FILES_PER_REPO)) {
      try {
        const blob = await stub.getBlob({ filepath: file.path }).catch(() => null);
        const text = decodeBlobToText(blob);
        if (text === null) continue;
        const ok = await search.indexFile({ repoId: repo.id, path: file.path, oid: file.oid, content: text });
        if (ok) indexed += 1;
      } catch (error) {
        logger.error(`Search backfill: failed to index ${repo.owner}/${repo.name}:${file.path}`, error);
      }
    }
    return indexed;
  }
}

export { SearchBackfillTask };
