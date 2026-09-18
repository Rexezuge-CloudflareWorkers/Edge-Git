import { getRepoStub } from '../repoStub';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import type { MergePreviewShape } from './PullShared';

const OID_RE = /^[0-9a-f]{40}$/;

interface ForkCopyResult {
  refs: string[];
  objects: number;
  empty: boolean;
}

function isPackLimitError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'PackLimitError' || /pack too large|too many objects|rev-walk too large|too many (?:wants|haves)/i.test(message);
}

// Copy all branches/tags from the source repo DO into the target repo DO
// (fork creation). The target must already exist (`ensureRepo`). Over-limit
// sources throw a pack-limit error so callers fail closed and roll back.
async function copyRepoGit(env: Env, sourceFullName: string, targetFullName: string): Promise<ForkCopyResult> {
  const source = getRepoStub(env, sourceFullName);
  const target = getRepoStub(env, targetFullName);
  const listed = await source.listRefs();
  const heads = (listed.refs ?? []).filter((r) => r.ref.startsWith('refs/heads/') || r.ref.startsWith('refs/tags/'));
  if (heads.length === 0) return { refs: [], objects: 0, empty: true };
  const exported = await source.exportPack(heads.map((r) => r.oid));
  if (!exported.pack) return { refs: [], objects: 0, empty: true };
  const { importedRefs } = await target.importPack(exported.pack, heads);
  return { refs: importedRefs, objects: exported.oids.length, empty: false };
}

// Materialize a head commit (plus its history) from the head repo DO into
// the base repo DO so merge-base/diff/merge can run where the base lives.
// No refs are created in the base repo — objects only.
async function ensureHeadObjects(env: Env, baseFullName: string, headFullName: string, headOid: string): Promise<void> {
  if (!OID_RE.test(headOid)) throw new Error('invalid head oid');
  const base = getRepoStub(env, baseFullName);
  if (await base.hasObject(headOid)) return;
  const head = getRepoStub(env, headFullName);
  const exported = await head.exportPack([headOid]);
  if (!exported.pack) throw new Error('head commit not found');
  await base.importPack(exported.pack);
}

interface CrossOids {
  baseOid: string;
  headOid: string;
}

// Split ref resolution across base/head DOs (cross-fork PRs).
async function resolveCrossOids(
  env: Env,
  baseFullName: string,
  baseBranch: string,
  headFullName: string,
  headBranch: string,
): Promise<CrossOids | null> {
  const base = getRepoStub(env, baseFullName);
  const head = getRepoStub(env, headFullName);
  const [baseOid, headOid] = await Promise.all([base.resolveRef(`refs/heads/${baseBranch}`), head.resolveRef(`refs/heads/${headBranch}`)]);
  if (!baseOid || !headOid) return null;
  return { baseOid, headOid };
}

// Cross-fork merge preview: resolve across DOs, materialize, preview by oid.
async function getCrossRepoPreview(
  env: Env,
  baseFullName: string,
  baseBranch: string,
  headFullName: string,
  headBranch: string,
): Promise<{ preview: MergePreviewShape | null; baseOid: string | null; headOid: string | null }> {
  const oids = await resolveCrossOids(env, baseFullName, baseBranch, headFullName, headBranch);
  if (!oids) return { preview: null, baseOid: null, headOid: null };
  await ensureHeadObjects(env, baseFullName, headFullName, oids.headOid);
  const preview = (await getRepoStub(env, baseFullName).getMergePreviewByOids({
    baseOid: oids.baseOid,
    headOid: oids.headOid,
  })) as MergePreviewShape | null;
  return { preview, baseOid: oids.baseOid, headOid: oids.headOid };
}

interface PullHeadRef {
  head_repository_id?: string | null;
  head_full_name?: string | null;
}

function isCrossRepoPull(pull: PullHeadRef): boolean {
  return Boolean(pull.head_repository_id ?? pull.head_full_name);
}

interface ResolvedHeadRepo {
  row: RepositoryRow;
  fullName: string;
}

// Resolve the live head repo for a cross-fork PR (stable id first, stored
// full name as fallback for legacy rows). Returns null for same-repo PRs.
async function resolveHeadRepo(env: Env, pull: PullHeadRef): Promise<ResolvedHeadRepo | null> {
  if (!isCrossRepoPull(pull)) return null;
  const scope = createRequestScope(env);
  const svc = scope.get(Tokens.RepoService);
  if (pull.head_repository_id) {
    const byId = await svc.getById(pull.head_repository_id).catch(() => null);
    if (byId) return { row: byId, fullName: `${byId.owner}/${byId.name}` };
  }
  if (pull.head_full_name) {
    const slash = pull.head_full_name.indexOf('/');
    if (slash > 0) {
      const byName = await svc
        .getByOwnerAndName(pull.head_full_name.slice(0, slash), pull.head_full_name.slice(slash + 1))
        .catch(() => null);
      if (byName) return { row: byName, fullName: `${byName.owner}/${byName.name}` };
    }
  }
  return null;
}

// Read access check on the head repo (hides private forks via null).
async function getHeadRole(env: Env, head: ResolvedHeadRepo, viewerEmail: string | null): Promise<'admin' | 'write' | 'read' | null> {
  const scope = createRequestScope(env);
  return scope
    .get(Tokens.PermissionService)
    .getRole(viewerEmail, head.row)
    .catch(() => null);
}

export {
  copyRepoGit,
  ensureHeadObjects,
  getCrossRepoPreview,
  getHeadRole,
  isCrossRepoPull,
  isPackLimitError,
  resolveCrossOids,
  resolveHeadRepo,
};
export type { ForkCopyResult };
