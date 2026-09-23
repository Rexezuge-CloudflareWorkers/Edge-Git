import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { TimestampUtil, repoDoKeyForFullName } from '@edge-git/shared/utils';

// Best-effort vacuum tombstone for delete paths that bypass
// `RepoService.deleteRepo` (fork-rollback cleanup, rename source purges),
// which enqueues its own tombstone. Never throws: a missed tombstone only
// delays SQLite page reclaim, never user-visible data.
async function enqueueRepoVacuum(env: Env, fullName: string, repoId: string): Promise<void> {
  try {
    const scope = createRequestScope(env);
    const dao = await scope.get(Tokens.DeletedRepoDoDAO)();
    await dao.enqueue(
      repoDoKeyForFullName(fullName),
      fullName,
      repoId,
      TimestampUtil.getCurrentUnixTimestampInSeconds(),
    );
  } catch {
    // Best-effort tombstone — the synchronous targeted DO purge already ran.
  }
}

export { enqueueRepoVacuum };
