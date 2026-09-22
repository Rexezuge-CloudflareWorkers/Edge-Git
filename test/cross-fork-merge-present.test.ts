import { describe, expect, it, vi } from 'vitest';

// `recordAndNotify` fans out through the real composition root (D1 + DO
// bindings). The presentation guarantee under test is orthogonal to fan-out,
// so it is stubbed here; fan-out itself is covered in
// `route-fill-hardening.test.ts`.
vi.mock('@/workers/routes/SocialEmit', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/workers/routes/SocialEmit')>();
  return { ...orig, recordAndNotify: vi.fn().mockResolvedValue(undefined) };
});

import { Tokens } from '@edge-git/backend-services/composition';
import { mergeCrossForkPull } from '@/workers/routes/PullMergeHelpers';

const BASE_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

function stubFor(name: string) {
  const oid = name.includes('bob') ? HEAD_OID : BASE_OID;
  return {
    setFullName: vi.fn().mockResolvedValue(undefined),
    resolveRef: vi.fn().mockResolvedValue(oid),
    hasObject: vi.fn().mockResolvedValue(true),
    exportPack: vi.fn().mockResolvedValue({ pack: null, oids: [] }),
    importPack: vi.fn().mockResolvedValue({}),
    getMergePreviewByOids: vi.fn().mockResolvedValue({ baseOid: BASE_OID, headOid: HEAD_OID, mergeBase: BASE_OID }),
    mergePull: vi.fn().mockResolvedValue({ type: 'fast-forward', commitOid: HEAD_OID }),
    deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
  };
}

function makeEnv() {
  return {
    REPO: { getByName: (name: string) => stubFor(name) as never },
  };
}

const MERGED_ROW = {
  id: 'pr-1',
  repository_id: 'r1',
  number: 1,
  title: 'From Fork',
  base_branch: 'main',
  head_branch: 'feat',
  creator_email: BOB,
  merged_by: ALICE,
  status: 'merged',
  base_oid: BASE_OID,
  head_oid: HEAD_OID,
};

function makeScope(overrides: { mergePullResult?: unknown; headRole?: string | null } = {}) {
  const permission = { getRole: vi.fn().mockResolvedValue(overrides.headRole === undefined ? 'read' : overrides.headRole) };
  const repo = { requireRole: vi.fn().mockResolvedValue(undefined) };
  const pulls = {
    refreshOids: vi.fn().mockResolvedValue(undefined),
    markMerged: vi.fn().mockResolvedValue(MERGED_ROW),
  };
  const identity = {
    resolveUsernames: vi
      .fn()
      .mockImplementation((emails: string[]) => Promise.resolve(new Map(emails.map((e) => [e.toLowerCase(), e.split('@')[0]])))),
  };
  const stubs = new Map<unknown, unknown>([
    [Tokens.PermissionService, permission],
    [Tokens.RepoService, repo],
    [Tokens.PullRequestService, pulls],
    [Tokens.IdentityResolver, identity],
  ]);
  const get = vi.fn((token: unknown) => {
    const svc = stubs.get(token);
    if (!svc) throw new Error('unexpected token');
    return svc;
  });
  if (overrides.mergePullResult !== undefined) {
    return { get, permission, repo, pulls, identity, mergePullResult: overrides.mergePullResult };
  }
  return { get, permission, repo, pulls, identity };
}

function baseInput(scope: ReturnType<typeof makeScope>, mergePullResult?: unknown) {
  const env = makeEnv();
  if (mergePullResult !== undefined) {
    const stub = stubFor('alice/demo');
    (stub.mergePull as ReturnType<typeof vi.fn>).mockResolvedValue(mergePullResult);
    (env.REPO.getByName as (name: string) => unknown) = () => stub as never;
  }
  return {
    env,
    input: {
      email: ALICE,
      scope: scope as never,
      rowId: 'r1',
      number: 1,
      pull: { title: 'From Fork', base_branch: 'main', head_branch: 'feat' },
      fullName: 'alice/demo',
      headFullName: 'bob/demo',
      headRow: { id: 'r2', owner: 'bob', name: 'demo' } as never,
      message: 'Merge pull request #1',
      deleteHead: false,
      strategy: 'merge' as const,
    },
  };
}

describe('mergeCrossForkPull identity presentation', () => {
  it('presents the merged pull with usernames, never raw emails', async () => {
    const scope = makeScope();
    const { env, input } = baseInput(scope);
    const result = await mergeCrossForkPull(env as never, input);
    expect(result.status).toBe(200);
    const pull = (result.body as { pull: Record<string, unknown> }).pull;
    expect(pull.creator_email).toBeUndefined();
    expect(pull.merged_by).toBeUndefined();
    expect(pull.creator).toBe('bob');
    expect(pull.mergedBy).toBe('alice');
    expect(pull.status).toBe('merged');
  });

  it('surfaces DO conflicts as 409 with the file list', async () => {
    const scope = makeScope();
    const { env, input } = baseInput(scope, { type: 'conflict', conflicts: ['README.md'], reason: 'both modified' });
    const result = await mergeCrossForkPull(env as never, input);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ conflicts: ['README.md'] });
  });

  it('hides head repos without any role as 404', async () => {
    const scope = makeScope({ headRole: null });
    const { env, input } = baseInput(scope);
    const result = await mergeCrossForkPull(env as never, input);
    expect(result.status).toBe(404);
  });
});
