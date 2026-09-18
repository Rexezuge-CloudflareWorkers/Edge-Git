import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { repoShardFor } from '@edge-git/shared/realtime';
import { ensureRepo, getRepoStub } from '../repoStub';
import { getRealtimeStub } from '../doStubs';
import { copyRepoGit } from './CrossFork';

interface RepoMoveItem {
  id: string;
  name: string;
  oldFull: string;
  newFull: string;
}

// Copy release-asset bytes for one repo (D1-driven: metadata already moved
// with the repo row since assets key by stable `repository_id`). Throws on
// store failures so callers fail closed instead of leaving the new repo
// without its release binaries. Missing assets on the source (evicted bytes)
// are skipped — metadata without bytes is the pre-existing state there too.
interface ReleaseAssetRef {
  releaseId: string;
  assetId: string;
}

async function copyOneAsset(
  source: ReturnType<typeof getRepoStub>,
  target: ReturnType<typeof getRepoStub>,
  asset: ReleaseAssetRef,
): Promise<void> {
  const bytes = await source.getReleaseAsset({ releaseId: asset.releaseId, assetId: asset.assetId }).catch(() => null);
  if (!bytes || bytes.byteLength === 0) return;
  const stored = (await target.storeReleaseAsset({ releaseId: asset.releaseId, assetId: asset.assetId, bytes })) as {
    ok?: boolean;
    error?: string;
  } | null;
  if (!stored?.ok) {
    throw new Error(typeof stored?.error === 'string' ? stored.error : `Failed to copy release asset ${asset.assetId}`);
  }
}

async function copyReleaseAssets(env: Env, repositoryId: string, oldFull: string, newFull: string): Promise<void> {
  const scope = createRequestScope(env);
  const releaseDAO = await scope.get(Tokens.ReleaseDAO)();
  const releases = await releaseDAO.listByRepo(repositoryId).catch(() => []);
  if (releases.length === 0) return;
  const source = getRepoStub(env, oldFull);
  const target = getRepoStub(env, newFull);
  for (const release of releases) {
    const assets = await releaseDAO.listAssets(release.id).catch(() => []);
    for (const asset of assets) {
      await copyOneAsset(source, target, { releaseId: release.id, assetId: asset.id });
    }
  }
}

// Best-effort redirect notice on the old realtime shard so connected clients
// can navigate to the new `owner/name`. Realtime holds no persistent history
// (30s single-use tickets + live sockets/presence only, GC'd by the DO alarm),
// so the old shard needs no copy — it idle-expires. Never throws.
async function notifyRealtimeRename(env: Env, actorEmail: string, oldFull: string, newFull: string): Promise<void> {
  try {
    let enabled = false;
    try {
      enabled = createRequestScope(env).get(Tokens.AppConfig).isRealtimeEnabled();
    } catch {
      return;
    }
    if (!enabled) return;
    const stub = getRealtimeStub(env, repoShardFor(oldFull));
    await stub
      .publish({
        channel: 'activity',
        type: 'repo_renamed',
        actor: actorEmail,
        title: `${oldFull} renamed to ${newFull}`,
        extra: { oldFullName: oldFull, newFullName: newFull },
      })
      .catch(() => undefined);
  } catch {
    // binding missing or scope unavailable — live updates are a nicety
  }
}

// Move one repo DO: fresh target, git copy, asset copy, then purge the source.
// On copy failure the half-made target is purged and the error rethrown with
// the source left intact, so callers can roll back D1 without data loss.
async function moveOneRepo(env: Env, actorEmail: string, move: RepoMoveItem): Promise<{ empty: boolean }> {
  await ensureRepo(env, move.newFull);
  try {
    const copied = await copyRepoGit(env, move.oldFull, move.newFull);
    await copyReleaseAssets(env, move.id, move.oldFull, move.newFull);
    await notifyRealtimeRename(env, actorEmail, move.oldFull, move.newFull);
    // Source purge is best-effort: the new DO is complete and D1 already
    // points at it, so a lingering old isolate only wastes space.
    await getRepoStub(env, move.oldFull)
      .deleteRepo()
      .catch(() => undefined);
    return { empty: copied.empty };
  } catch (error) {
    await getRepoStub(env, move.newFull)
      .deleteRepo()
      .catch(() => undefined);
    throw error;
  }
}

// Copy one repo DO back (compensation for an already-moved repo when a later
// repo fails). Best-effort: returns false when the copy-back itself fails, in
// which case the data still exists under the new name.
async function moveOneRepoBack(env: Env, move: RepoMoveItem): Promise<boolean> {
  try {
    await ensureRepo(env, move.oldFull);
    await copyRepoGit(env, move.newFull, move.oldFull);
    await copyReleaseAssets(env, move.id, move.newFull, move.oldFull);
    await getRepoStub(env, move.newFull)
      .deleteRepo()
      .catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

// Fail-closed multi-repo move for owner/org renames (D1 already committed).
// Repos move sequentially; on the first failure, already-moved repos are
// copied back and the original error is rethrown so the route can compensate
// D1 (inverse rename) and surface 413/500 instead of an empty repo.
async function moveRepoDosForRename(
  env: Env,
  actorEmail: string,
  moves: RepoMoveItem[],
): Promise<{ moved: number; empty: number }> {
  const completed: RepoMoveItem[] = [];
  let moved = 0;
  let empty = 0;
  try {
    for (const move of moves) {
      if (!move?.oldFull || !move?.newFull || move.oldFull === move.newFull) continue;
      const result = await moveOneRepo(env, actorEmail, move);
      completed.push(move);
      moved += 1;
      if (result.empty) empty += 1;
    }
    return { moved, empty };
  } catch (error) {
    for (let i = completed.length - 1; i >= 0; i -= 1) {
      await moveOneRepoBack(env, completed[i]);
    }
    throw error;
  }
}

export { moveRepoDosForRename, moveOneRepo };
export type { RepoMoveItem };
