import type { GitService, IsoGitFs } from '@edge-git/git-service';
import { createLogger } from '@edge-git/backend-runtime/logger';

const logger = createLogger('PackCompactor');

const PACK_DIR = '/repo/objects/pack';
// Consolidate only when fragmentation is material: each push adds one pack
// file and every object lookup fans out across packs, so rows_read grows with
// push count. 20 keeps compaction rare (amortized) while bounding fan-out.
const PACK_COMPACTION_THRESHOLD = 20;
const MAX_COMPACTION_WANTS = 1000;

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

interface CompactPacksInput {
  isoGitFs: PromiseFsClient | undefined;
  git: GitService;
  maxObjects: number;
  maxPackBytes: number;
  fullName: string | undefined;
}

// Best-effort pack consolidation: rebuilds all reachable objects into one
// `gc-*.pack` and deletes the fragmented predecessors. Never throws —
// failures keep the old packs (correct, just fragmented) and only log.
// Verification (every advertised tip readable after indexing) runs before any
// delete, so an interrupted compaction cannot lose objects.
async function maybeCompactPacks(input: CompactPacksInput): Promise<{ compacted: boolean; deleted: number }> {
  const idle = { compacted: false, deleted: 0 };
  const { isoGitFs, git, maxObjects, maxPackBytes, fullName } = input;
  if (!isoGitFs) return idle;
  let names: string[];
  try {
    names = await isoGitFs.promises.readdir(PACK_DIR);
  } catch {
    return idle;
  }
  const packs = names.filter((n) => n.endsWith('.pack'));
  if (packs.length <= PACK_COMPACTION_THRESHOLD) return idle;

  try {
    const { refs } = await git.listRefs();
    const wants = [...new Set(refs.map((r) => r.oid).filter((oid) => /^[0-9a-f]{40}$/i.test(oid)))].slice(0, MAX_COMPACTION_WANTS);
    if (wants.length === 0) return idle;
    const { oids } = await git.collectObjectsForPack(wants, [], { maxObjects });
    if (oids.length === 0 || oids.length > maxObjects) return idle;
    const packed = (await git.packObjects(oids)) as Uint8Array | undefined;
    if (!packed || packed.byteLength === 0 || packed.byteLength > maxPackBytes) return idle;

    const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const fileName = `gc-${suffix}.pack`;
    const packFilePath = `${PACK_DIR}/${fileName}`;
    await isoGitFs.promises.writeFile(packFilePath, packed);
    try {
      await git.indexPack(`objects/pack/${fileName}`);
    } catch (error) {
      await isoGitFs.promises.unlink(packFilePath).catch(() => undefined);
      throw error;
    }
    for (const want of wants) {
      if (!(await git.hasObject(want).catch(() => false))) {
        await isoGitFs.promises.unlink(packFilePath).catch(() => undefined);
        await isoGitFs.promises.unlink(packFilePath.replace(/\.pack$/, '.idx')).catch(() => undefined);
        git.clearCache();
        return idle;
      }
    }
    let deleted = 0;
    for (const old of packs) {
      const oldPack = `${PACK_DIR}/${old}`;
      const oldIdx = oldPack.replace(/\.pack$/, '.idx');
      try {
        await isoGitFs.promises.unlink(oldPack);
        deleted += 1;
      } catch {
        continue;
      }
      await isoGitFs.promises.unlink(oldIdx).catch(() => undefined);
    }
    git.clearCache();
    logger.info(`(pack-compact) Compacted ${deleted} packs for ${fullName ?? 'unknown repo'} into ${fileName} (${oids.length} objects)`);
    return { compacted: deleted > 0, deleted };
  } catch (error) {
    logger.error(`(pack-compact) Compaction skipped for ${fullName ?? 'unknown repo'}: `, error);
    try {
      git.clearCache();
    } catch {
      // Best-effort only.
    }
    return idle;
  }
}

export { maybeCompactPacks, PACK_COMPACTION_THRESHOLD, PACK_DIR };
