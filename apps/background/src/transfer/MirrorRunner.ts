import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { fetchRemotePack } from '@edge-git/git-protocol';
import { TimestampUtil, repoDoKeyForFullName } from '@edge-git/shared/utils';
import { workerFetchAdapter } from './fetchAdapter';

const logger = createLogger('MirrorRunner');
const ZERO_OID = '0'.repeat(40);

interface MirrorStub {
  listRefs(): Promise<{ refs: Array<{ ref: string; oid: string }>; symbolicHead: string | null }>;
  resolveRef(ref: string): Promise<string | null>;
  importPack(pack: Uint8Array): Promise<{ importedRefs: string[] }>;
  isAncestor(ancestor: string, oid: string): Promise<boolean>;
  updateRefs(updates: Array<{ ref: string; oldOid: string; newOid: string }>): Promise<{ updated: string[] }>;
  setDefaultBranch(branch: string): Promise<unknown>;
}

// Sync one mirror: fetch the remote advertisement + pack, index objects,
// then fast-forward heads and create missing tags. Never force-updates,
// never deletes, never touches diverged branches. Never throws — the
// outcome is recorded on the mirror row (consecutive failures auto-disable).
async function runMirrorSync(env: Env, repositoryId: string): Promise<void> {
  const scope = createRequestScope(env);
  const mirrorDAO = await scope.get(Tokens.MirrorDAO)();
  const mirror = await mirrorDAO.getByRepo(repositoryId).catch(() => null);
  if (!mirror || mirror.enabled !== 1) return;
  const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
  const maxFailures = scope.get(Tokens.MirrorService).maxFailures();
  const fail = async (message: string): Promise<void> => {
    logger.error(`Mirror sync for ${repositoryId} failed: ${message}`);
    await mirrorDAO
      .recordRun(repositoryId, false, message, TimestampUtil.getCurrentUnixTimestampInSeconds(), maxFailures)
      .catch(() => undefined);
  };
  try {
    const repoDAO = await scope.get(Tokens.RepositoryDAO)();
    const repo = await repoDAO.getById(repositoryId).catch(() => null);
    if (!repo) {
      await mirrorDAO.deleteByRepo(repositoryId).catch(() => undefined);
      return;
    }
    const fullName = `${repo.owner}/${repo.name}`;
    // Route via the canonical lowercase DO key (see doStubs.getRepoStub):
    // raw-case getByName forks a second isolate that reads never see.
    const stub = env.REPO.getByName(repoDoKeyForFullName(fullName)) as unknown as MirrorStub;
    const local = await stub.listRefs().catch(() => null);
    const localByRef = new Map((local?.refs ?? []).map((r) => [r.ref, r.oid]));
    const limits = scope.get(Tokens.ImportService).transferLimits();
    const { refs: remoteRefs, pack, symbolicHead } = await fetchRemotePack(workerFetchAdapter(), mirror.source_url, {
      maxRefs: limits.maxRefs,
      maxPackBytes: limits.maxPackBytes,
      timeoutMs: limits.timeoutMs,
    });
    await stub.importPack(pack);
    const updates: Array<{ ref: string; oldOid: string; newOid: string }> = [];
    let skipped = 0;
    for (const remote of remoteRefs) {
      const localOid = localByRef.get(remote.ref);
      if (!localOid) {
        updates.push({ ref: remote.ref, oldOid: ZERO_OID, newOid: remote.oid });
        continue;
      }
      if (localOid === remote.oid) continue;
      if (!remote.ref.startsWith('refs/heads/')) continue;
      const fastForward = await stub.isAncestor(localOid, remote.oid).catch(() => false);
      if (fastForward) {
        updates.push({ ref: remote.ref, oldOid: localOid, newOid: remote.oid });
      } else {
        skipped += 1;
      }
    }
    if (updates.length > 0) {
      await stub.updateRefs(updates).catch(() => ({ updated: [] }));
    }
    // Preserve the upstream default branch: a fresh repo's HEAD points at
    // `main`, which dangles when the source lives elsewhere (e.g. `master`).
    // Best-effort and self-healing — the next sync repairs older mirrors too.
    if (symbolicHead && symbolicHead.startsWith('refs/heads/')) {
      const branch = symbolicHead.slice('refs/heads/'.length);
      const landed = new Set([...localByRef.keys(), ...updates.map((u) => u.ref)]);
      if (landed.has(symbolicHead)) {
        await stub.setDefaultBranch(branch).catch(() => undefined);
      }
    }
    await mirrorDAO.recordRun(repositoryId, true, null, now, maxFailures).catch(() => undefined);
    logger.info(`Mirror sync for ${fullName} ok: ${updates.length} refs updated, ${skipped} diverged skipped`);
  } catch (error) {
    await fail(error instanceof Error ? error.message : 'mirror sync failed');
  }
}

export { runMirrorSync };
