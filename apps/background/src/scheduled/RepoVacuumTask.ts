import type { DeletedRepoDoRow, RepositoryDAO } from '@edge-git/backend-data/dao';
import type { KvCache } from '@edge-git/backend-runtime/kv';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { TimestampUtil, repoDoKeyForFullName } from '@edge-git/shared/utils';
import { BaseScheduledTask } from './IScheduledTask';

const logger = createLogger('CronTasks');

// Tombstones younger than this stay untouched: the synchronous delete path
// already purged the live content, and the grace window lets DO isolates
// drain plus same-name recreates land before any `deleteAll` fires.
const VACUUM_GRACE_SECONDS = 600;
const VACUUM_CLAIM_LIMIT = 10;
// A tombstone that fails this often is poison (bad key, dead namespace) —
// drop it loudly instead of retrying forever.
const VACUUM_MAX_ATTEMPTS = 10;

interface RepoVacuum {
  vacuum(): Promise<{ vacuumed: boolean; reason: string }>;
}

interface CheckQueuePurge {
  purgeRepo(repositoryId: string): Promise<unknown>;
}

// Background reclaim for deleted-repo Durable Object storage. The
// synchronous delete keeps a fast targeted purge (`/repo` +
// `/release-assets`) so recreates work on the warm isolate; this task
// finishes the job minutes later: full `storage.deleteAll()` on the REPO
// isolate (frees the SQLite pages the dashboard reports), CHECK_RUNNER queue
// purge, and KV read-model invalidation.
//
// Recreate-safety is two-layered: the task only vacuums while the canonical
// DO key maps to no live D1 repository, and the `vacuum()` RPC itself aborts
// when the `fullName` binding is present (a recreate re-persists it first).
class RepoVacuumTask extends BaseScheduledTask {
  public readonly name = 'RepoVacuumTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const scope = createRequestScope(env);
    const tombstones = await scope.get(Tokens.DeletedRepoDoDAO)().catch(() => null);
    if (!tombstones) return;
    const repositoryDAO = await scope.get(Tokens.RepositoryDAO)().catch(() => null);
    if (!repositoryDAO) return;
    const kv = scope.get(Tokens.KvCache);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const due = await tombstones.listDue(now - VACUUM_GRACE_SECONDS, VACUUM_CLAIM_LIMIT).catch(() => []);
    let vacuumed = 0;
    for (const tomb of due) {
      try {
        await this.vacuumOne(env, repositoryDAO, kv, tomb);
        await tombstones.remove(tomb.do_key).catch(() => undefined);
        vacuumed += 1;
      } catch (error) {
        logger.error(`Repo vacuum: failed for ${tomb.full_name}`, error);
        try {
          const attempts = await tombstones.recordAttempt(tomb.do_key);
          if (attempts >= VACUUM_MAX_ATTEMPTS) {
            await tombstones.remove(tomb.do_key).catch(() => undefined);
            logger.error(`Repo vacuum: dropping poison tombstone ${tomb.do_key} after ${attempts} attempts`);
          }
        } catch {
          // Attempt accounting failed — the tombstone retries next tick.
        }
      }
    }
    if (vacuumed > 0) logger.info(`Repo vacuum reclaimed ${vacuumed} deleted repo DOs`);
  }

  private async vacuumOne(env: Env, repositoryDAO: RepositoryDAO, kv: KvCache, tomb: DeletedRepoDoRow): Promise<void> {
    const { owner, name } = splitFullName(tomb.full_name);
    const current = owner && name ? await repositoryDAO.getByOwnerAndName(owner, name).catch(() => null) : null;
    // Filtered by repoId, so safe (and desirable) even when the name was
    // recreated — stale queue items reference the dead repository id.
    await purgeCheckQueue(env, tomb).catch(() => undefined);
    if (current) {
      // Name live again: the DO now belongs to the new repo. KV serves the
      // live name, so it is left alone.
      return;
    }
    const repo = (env as unknown as { REPO?: { getByName(key: string): unknown } }).REPO?.getByName(tomb.do_key) as
      | RepoVacuum
      | undefined;
    if (!repo) throw new Error('REPO binding is not configured');
    const result = await repo.vacuum();
    if (!result.vacuumed) {
      logger.info(`Repo vacuum: skipped ${tomb.full_name} (${result.reason})`);
      return;
    }
    const key = repoDoKeyForFullName(tomb.full_name);
    await kv.del('refs', [key, 'snapshot']);
    await kv.purgePrefix('readmodel', [key]);
  }
}

async function purgeCheckQueue(env: Env, tomb: DeletedRepoDoRow): Promise<void> {
  const ns = (env as unknown as { CHECK_RUNNER?: { getByName(key: string): unknown } }).CHECK_RUNNER;
  if (!ns) return;
  const stub = ns.getByName(tomb.do_key) as CheckQueuePurge;
  await stub.purgeRepo(tomb.repo_id);
}

function splitFullName(fullName: string): { owner: string; name: string } {
  const [owner = '', ...rest] = fullName.split('/');
  return { owner, name: rest.join('/') };
}

export { RepoVacuumTask, VACUUM_GRACE_SECONDS };
