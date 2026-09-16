import { describe, expect, it } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { ForkService } from '@edge-git/backend-services/fork';
import { MergeService } from '../packages/git-service/src/MergeService';

// In-memory D1 fake covering repositories (+fork lineage), users, namespaces,
// organizations, collaborators, and pull_requests (+head repo columns).
function createForkFakeDb() {
  const state = {
    repos: [] as Array<Record<string, unknown>>,
    users: [] as Array<Record<string, unknown>>,
    collabs: [] as Array<Record<string, unknown>>,
    pulls: [] as Array<Record<string, unknown>>,
    reviews: [] as Array<Record<string, unknown>>,
    comments: [] as Array<Record<string, unknown>>,
  };

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM repositories WHERE lower(owner)')) {
          const row = state.repos.find(
            (r) => String(r.owner).toLowerCase() === String(params[0]).toLowerCase() && String(r.name).toLowerCase() === String(params[1]).toLowerCase(),
          );
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE id = ?')) {
          const row = state.repos.find((r) => r.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS n') && q.includes('forked_from_repo_id')) {
          const n = state.repos.filter((r) => r.forked_from_repo_id === params[0]).length;
          return Promise.resolve({ n } as unknown as T);
        }
        if (q.includes('COALESCE(MAX(number)') && q.includes('FROM pull_requests')) {
          const max = state.pulls.filter((p) => p.repository_id === params[0]).reduce((m, p) => Math.max(m, p.number as number), 0);
          return Promise.resolve({ max_n: max } as unknown as T);
        }
        if (q.includes('FROM pull_requests WHERE repository_id = ? AND number = ?')) {
          const row = state.pulls.find((p) => p.repository_id === params[0] && p.number === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE lower(email)')) {
          const row = state.users.find((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase());
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repo_collaborators WHERE repo_id = ? AND lower(user_email)')) {
          const row = state.collabs.find((c) => c.repo_id === params[0] && String(c.user_email).toLowerCase() === String(params[1]).toLowerCase());
          return Promise.resolve((row ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM repositories WHERE lower(owner_email)')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner_email).toLowerCase() === String(params[0]).toLowerCase()) as T[] });
        }
        if (q.includes('FROM repositories WHERE forked_from_repo_id = ?')) {
          const rows = state.repos
            .filter((r) => r.forked_from_repo_id === params[0])
            .sort((a, b) => (b.updated_at as number) - (a.updated_at as number))
            .slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM pull_requests WHERE repository_id = ?')) {
          const rows = state.pulls
            .filter((p) => p.repository_id === params[0])
            .sort((a, b) => (b.number as number) - (a.number as number))
            .slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM pull_request_reviews WHERE pull_request_id = ?')) {
          const rows = state.reviews
            .filter((r) => r.pull_request_id === params[0])
            .sort((a, b) => (a.created_at as number) - (b.created_at as number));
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM pull_request_comments WHERE pull_request_id = ?')) {
          const rows = state.comments
            .filter((c) => c.pull_request_id === params[0])
            .sort((a, b) => (a.created_at as number) - (b.created_at as number));
          return Promise.resolve({ results: rows as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO repositories')) {
          const [id, owner_email, owner, name, description, is_private, created_at, updated_at] = params as Array<string | number | null>;
          const row: Record<string, unknown> = { id, owner_email, owner, name, description, is_private, created_at, updated_at };
          if (params.length > 8) {
            const [, , , , , , , , owner_type, owner_ci, name_ci, owner_user_email, org_id, forked_from_repo_id, forked_from_full_name] = params as Array<
              string | number | null
            >;
            Object.assign(row, { owner_type, owner_ci, name_ci, owner_user_email, org_id, forked_from_repo_id, forked_from_full_name });
          }
          state.repos.push(row);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repositories WHERE id = ?')) {
          state.repos = state.repos.filter((r) => r.id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO users')) {
          const [email, created_at] = params as Array<string | number>;
          if (!state.users.some((u) => u.email === email)) state.users.push({ email, created_at, username: null });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO pull_requests')) {
          const [id, repository_id, full_name, number, title, body, status, base_branch, head_branch, base_oid, head_oid, merge_base_oid, creator_email, created_at, updated_at] =
            params as Array<string | number | null>;
          const row: Record<string, unknown> = {
            id, repository_id, full_name, number, title, body, status, base_branch, head_branch, base_oid, head_oid,
            merge_base_oid, creator_email, merged_by: null, merged_at: null, created_at, updated_at,
            head_repository_id: params.length > 15 ? params[15] : null,
            head_full_name: params.length > 16 ? params[16] : null,
          };
          state.pulls.push(row);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE pull_requests SET status = ?') && q.includes('merged_by')) {
          const [, merged_by, merged_at, commitOid, updated_at, id] = params as Array<string | number | null>;
          const row = state.pulls.find((p) => p.id === id);
          if (row) {
            row.status = 'merged';
            row.merged_by = merged_by;
            row.merged_at = merged_at;
            if (commitOid) row.head_oid = commitOid;
            row.updated_at = updated_at;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE pull_requests SET status = ?')) {
          const [status, updated_at, id] = params as Array<string | number>;
          const row = state.pulls.find((p) => p.id === id);
          if (row) {
            row.status = status;
            row.updated_at = updated_at;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE pull_requests SET base_oid')) {
          const [baseOid, headOid, mergeBaseOid, updated_at, id] = params as Array<string | number | null>;
          const row = state.pulls.find((p) => p.id === id);
          if (row) {
            if (baseOid) row.base_oid = baseOid;
            if (headOid) row.head_oid = headOid;
            if (mergeBaseOid) row.merge_base_oid = mergeBaseOid;
            row.updated_at = updated_at;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO pull_request_reviews')) {
          const [id, pull_request_id, author_email, rstate, rbody, commit_oid, created_at] = params as Array<string | number | null>;
          state.reviews.push({ id, pull_request_id, author_email, state: rstate, body: rbody, commit_oid, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO pull_request_comments')) {
          const [id, pull_request_id, author_email, rbody, created_at] = params as Array<string | number>;
          state.comments.push({ id, pull_request_id, author_email, body: rbody, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      },
    };
  }

  const db = { ...state, prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) };
  return db as unknown as D1Queryable & typeof state;
}

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function seedRepo(db: D1Queryable & { repos: Array<Record<string, unknown>> }, row: Record<string, unknown>) {
  db.repos.push({ description: null, is_private: 0, created_at: 1, updated_at: 2, ...row });
}

function seedUser(db: D1Queryable & { users: Array<Record<string, unknown>> }, email: string, username: string) {
  db.users.push({ email, created_at: 1, username });
}

interface GitSeed {
  refs: Array<{ ref: string; oid: string }>;
  objects: string[];
}

// Per-repo DO stub with pack export/import simulated by encoding oid lists.
function createGitHarness() {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const git = new Map<string, { refs: Array<{ ref: string; oid: string }>; objects: Set<string> }>();
  const calls: Array<{ repo: string; method: string; args: unknown }> = [];
  const deletedBranches: Array<{ repo: string; branch: string }> = [];

  function ensure(name: string) {
    if (!git.has(name)) git.set(name, { refs: [], objects: new Set() });
    return git.get(name)!;
  }

  function seed(name: string, seedData: GitSeed) {
    const s = ensure(name);
    s.refs = [...seedData.refs];
    s.objects = new Set(seedData.objects);
  }

  function stubFor(name: string) {
    const s = ensure(name);
    return {
      setFullName: () => Promise.resolve(),
      ensureRepoInitialized: () => Promise.resolve(),
      deleteRepo: () => {
        git.delete(name);
        return Promise.resolve();
      },
      listRefs: () => Promise.resolve({ refs: s.refs, symbolicHead: null }),
      getBranches: () => Promise.resolve({ branches: s.refs.filter((r) => r.ref.startsWith('refs/heads/')).map((r) => r.ref.replace('refs/heads/', '')), currentBranch: 'main' }),
      resolveRef: (ref: string) => Promise.resolve(s.refs.find((r) => r.ref === ref)?.oid ?? null),
      hasObject: (oid: string) => Promise.resolve(s.objects.has(oid)),
      exportPack: (wants: string[]) => {
        calls.push({ repo: name, method: 'exportPack', args: wants });
        if (wants.some((w) => !s.objects.has(w))) return Promise.resolve({ oids: [], pack: null });
        return Promise.resolve({ oids: wants, pack: enc.encode(JSON.stringify(wants)) });
      },
      importPack: (pack: Uint8Array, refs?: Array<{ ref: string; oid: string }>) => {
        calls.push({ repo: name, method: 'importPack', args: { bytes: pack.byteLength, refs } });
        const oids = JSON.parse(dec.decode(pack)) as string[];
        for (const o of oids) s.objects.add(o);
        const importedRefs: string[] = [];
        for (const r of refs ?? []) {
          if (!s.refs.some((x) => x.ref === r.ref)) {
            s.refs.push({ ref: r.ref, oid: r.oid });
            s.objects.add(r.oid);
            importedRefs.push(r.ref);
          }
        }
        return Promise.resolve({ importedRefs });
      },
      getMergePreview: ({ baseRef, headRef }: { baseRef: string; headRef: string }) => {
        const baseOid = s.refs.find((r) => r.ref === baseRef)?.oid ?? null;
        const headOid = s.refs.find((r) => r.ref === headRef)?.oid ?? null;
        if (!baseOid || !headOid) return Promise.resolve(null);
        return Promise.resolve({ baseOid, headOid, mergeBase: baseOid, alreadyMerged: false, canFastForward: true });
      },
      getMergePreviewByOids: ({ baseOid, headOid }: { baseOid: string; headOid: string }) => {
        if (!s.objects.has(baseOid) || !s.objects.has(headOid)) return Promise.resolve(null);
        return Promise.resolve({ baseOid, headOid, mergeBase: baseOid, alreadyMerged: false, canFastForward: true });
      },
      getPullDiff: ({ baseOid, headOid }: { baseOid: string | null; headOid: string }) => {
        if (!s.objects.has(headOid)) return Promise.reject(new Error('unknown commit'));
        return Promise.resolve({ mergeBase: baseOid, truncated: false, changes: [{ type: 'add', path: 'fork.txt' }] });
      },
      mergePull: (args: Record<string, unknown>) => {
        calls.push({ repo: name, method: 'mergePull', args });
        return Promise.resolve({ type: 'fast-forward', commitOid: args.headOid, deletedHead: false });
      },
      deleteBranch: (branch: string) => {
        deletedBranches.push({ repo: name, branch });
        const i = s.refs.findIndex((r) => r.ref === `refs/heads/${branch}`);
        if (i >= 0) s.refs.splice(i, 1);
        return Promise.resolve({ deleted: true });
      },
    };
  }

  return { seed, stubFor, calls, deletedBranches, git };
}

function createEnv(db: D1Queryable, harness: ReturnType<typeof createGitHarness>, email: string) {
  return {
    DB: db,
    REPO: { getByName: (name: string) => harness.stubFor(name), get: (name: string) => harness.stubFor(name), idFromName: (n: string) => n },
    DEV_AUTH_EMAIL: email,
  };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const json = { 'content-type': 'application/json' };

async function call(env: unknown, path: string, init?: RequestInit): Promise<Response> {
  const worker = new EdgeGitWorker();
  const onRequest = (worker as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> }).onRequest.bind(worker);
  return onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);
}

function seedBase(db: ReturnType<typeof createForkFakeDb>) {
  seedUser(db, 'alice@example.com', 'alice');
  seedUser(db, 'bob@example.com', 'bob');
  seedUser(db, 'carol@example.com', 'carol');
  seedRepo(db, { id: 'r1', owner_email: 'alice@example.com', owner: 'alice', name: 'demo', owner_user_email: 'alice@example.com' });
}

describe('ForkService', () => {
  it('creates fork rows with user-specified owner and name', async () => {
    const db = createForkFakeDb();
    seedBase(db);
    const svc = new ForkService({ DB: db });
    const fork = await svc.createForkRow('bob@example.com', 'alice', 'demo', { owner: 'bob', name: 'demo-fork' });
    expect(fork).toMatchObject({ owner: 'bob', name: 'demo-fork', fullName: 'bob/demo-fork' });
    const stored = db.repos.find((r) => r.id === fork.id);
    expect(stored).toMatchObject({ forked_from_repo_id: 'r1', forked_from_full_name: 'alice/demo' });
  });

  it('defaults dest owner to the forker and name to the source', async () => {
    const db = createForkFakeDb();
    seedBase(db);
    const svc = new ForkService({ DB: db });
    const fork = await svc.createForkRow('bob@example.com', 'alice', 'demo', {});
    expect(fork).toMatchObject({ owner: 'bob', name: 'demo' });
  });

  it('forces private forks of private sources and hides invisible sources', async () => {
    const db = createForkFakeDb();
    seedBase(db);
    seedRepo(db, { id: 'r9', owner_email: 'alice@example.com', owner: 'alice', name: 'secret', owner_user_email: 'alice@example.com', is_private: 1 });
    const svc = new ForkService({ DB: db });
    const fork = await svc.createForkRow('alice@example.com', 'alice', 'secret', { owner: 'alice', name: 'secret-fork', isPrivate: false });
    expect(fork.isPrivate).toBe(true);
    await expect(svc.createForkRow('bob@example.com', 'alice', 'secret', {})).rejects.toThrow(/not found/i);
    await expect(svc.createForkRow('alice@example.com', 'alice', 'demo', { owner: 'alice', name: 'demo' })).rejects.toThrow(/itself/i);
  });

  it('lists and counts forks', async () => {
    const db = createForkFakeDb();
    seedBase(db);
    const svc = new ForkService({ DB: db });
    await svc.createForkRow('bob@example.com', 'alice', 'demo', { owner: 'bob', name: 'demo' });
    expect(await svc.countForks('r1')).toBe(1);
    expect(await svc.listForks('r1')).toHaveLength(1);
    expect(await svc.countForks('missing')).toBe(0);
  });
});

describe('Fork API routes', () => {
  it('forks with explicit owner+name and copies git refs', async () => {
    const db = createForkFakeDb();
    seedBase(db);
    const harness = createGitHarness();
    harness.seed('alice/demo', { refs: [{ ref: 'refs/heads/main', oid: OID_A }], objects: [OID_A] });
    const bob = createEnv(db, harness, 'bob@example.com');

    const res = await call(bob, '/user/repos/alice/demo/forks', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ owner: 'bob', name: 'demo-fork' }),
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ owner: 'bob', name: 'demo-fork', fullName: 'bob/demo-fork', forkedFrom: 'alice/demo' });

    // Target DO received the branch refs and objects.
    const target = harness.stubFor('bob/demo-fork');
    await expect(target.resolveRef('refs/heads/main')).resolves.toBe(OID_A);
    await expect(target.hasObject(OID_A)).resolves.toBe(true);

    // Fork listing exposes the fork with a visible count.
    await expect(call(bob, '/repos/alice/demo/forks').then((r) => r.json())).resolves.toMatchObject({ count: 1, forks: [{ fullName: 'bob/demo-fork' }] });
    await expect(call(bob, '/repos/bob/demo-fork').then((r) => r.json())).resolves.toMatchObject({ forkedFrom: 'alice/demo', forksCount: 0 });
  });

  it('rejects unknown sources and rolls back failed copies', async () => {
    const db = createForkFakeDb();
    seedBase(db);
    const harness = createGitHarness();
    const bob = createEnv(db, harness, 'bob@example.com');

    expect((await call(bob, '/user/repos/alice/missing/forks', { method: 'POST', headers: json, body: '{}' })).status).toBe(404);

    // Empty source (no refs) still forks the D1 row.
    harness.seed('alice/demo', { refs: [], objects: [] });
    expect((await call(bob, '/user/repos/alice/demo/forks', { method: 'POST', headers: json, body: JSON.stringify({ name: 'empty-fork' }) })).status).toBe(201);
    expect(db.repos.some((r) => r.name === 'empty-fork')).toBe(true);
  });

  it('hides private forks from unauthorized viewers', async () => {
    const db = createForkFakeDb();
    seedBase(db);
    seedRepo(db, { id: 'r9', owner_email: 'alice@example.com', owner: 'alice', name: 'secret', owner_user_email: 'alice@example.com', is_private: 1 });
    const harness = createGitHarness();
    harness.seed('alice/secret', { refs: [{ ref: 'refs/heads/main', oid: OID_A }], objects: [OID_A] });
    const alice = createEnv(db, harness, 'alice@example.com');
    const bob = createEnv(db, harness, 'bob@example.com');

    expect((await call(alice, '/user/repos/alice/secret/forks', { method: 'POST', headers: json, body: JSON.stringify({ name: 'secret-fork' }) })).status).toBe(201);
    // Bob cannot see the private source at all, hence no forks either.
    expect((await call(bob, '/repos/alice/secret/forks')).status).toBe(404);
    // Bob cannot see the private fork in the owner's other listings.
    const listed = (await (await call(alice, '/repos/alice/secret/forks')).json()) as { count: number };
    expect(listed.count).toBe(1);
  });
});

describe('Cross-fork pull requests', () => {
  function seedForkWorld(db: ReturnType<typeof createForkFakeDb>, harness: ReturnType<typeof createGitHarness>) {
    seedBase(db);
    seedRepo(db, { id: 'r2', owner_email: 'bob@example.com', owner: 'bob', name: 'demo', owner_user_email: 'bob@example.com', forked_from_repo_id: 'r1', forked_from_full_name: 'alice/demo' });
    harness.seed('alice/demo', { refs: [{ ref: 'refs/heads/main', oid: OID_A }], objects: [OID_A] });
    harness.seed('bob/demo', { refs: [{ ref: 'refs/heads/main', oid: OID_B }], objects: [OID_B] });
  }

  it('opens a cross-fork PR with head repo linkage', async () => {
    const db = createForkFakeDb();
    const harness = createGitHarness();
    seedForkWorld(db, harness);
    const bob = createEnv(db, harness, 'bob@example.com');

    const res = await call(bob, '/user/repos/alice/demo/pulls', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'From Fork', baseBranch: 'main', headBranch: 'main', headOwner: 'bob', headRepo: 'demo' }),
    });
    expect(res.status).toBe(201);
    const stored = db.pulls.find((p) => p.number === 1);
    expect(stored).toMatchObject({ head_repository_id: 'r2', head_full_name: 'bob/demo', head_oid: OID_B, base_oid: OID_A });
    // Head objects were materialized into the base DO.
    await expect(harness.stubFor('alice/demo').hasObject(OID_B)).resolves.toBe(true);
  });

  it('rejects cross-fork PRs with invisible heads or partial head selectors', async () => {
    const db = createForkFakeDb();
    const harness = createGitHarness();
    seedForkWorld(db, harness);
    const bob = createEnv(db, harness, 'bob@example.com');

    expect(
      (await call(bob, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'X', baseBranch: 'main', headBranch: 'main', headOwner: 'bob' }) })).status,
    ).toBe(400);
    expect(
      (await call(bob, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'X', baseBranch: 'main', headBranch: 'main', headOwner: 'mallory', headRepo: 'demo' }) })).status,
    ).toBe(404);
  });

  it('serves cross-fork preview and diff, gating private heads', async () => {
    const db = createForkFakeDb();
    const harness = createGitHarness();
    seedForkWorld(db, harness);
    const bob = createEnv(db, harness, 'bob@example.com');

    expect(
      (await call(bob, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'From Fork', baseBranch: 'main', headBranch: 'main', headOwner: 'bob', headRepo: 'demo' }) })).status,
    ).toBe(201);
    await expect(call(bob, '/repos/alice/demo/pulls/1/preview').then((r) => r.json())).resolves.toMatchObject({ preview: { headOid: OID_B } });
    await expect(call(bob, '/repos/alice/demo/pulls/1/diff').then((r) => r.json())).resolves.toMatchObject({ diff: { truncated: false } });

    // Privatize the fork: anonymous preview/diff must not leak it.
    const fork = db.repos.find((r) => r.id === 'r2')!;
    fork.is_private = 1;
    const anon = createEnv(db, harness, 'nobody@example.com');
    delete (anon as Record<string, unknown>).DEV_AUTH_EMAIL;
    expect((await call(anon, '/repos/alice/demo/pulls/1/preview')).status).toBe(404);
    expect((await call(anon, '/repos/alice/demo/pulls/1/diff')).status).toBe(404);
  });

  it('merges cross-fork PRs and deletes the head branch in the fork', async () => {
    const db = createForkFakeDb();
    const harness = createGitHarness();
    seedForkWorld(db, harness);
    // Alice (base admin) also holds write on bob's fork, so deleteHead works.
    db.collabs.push({ repo_id: 'r2', user_email: 'alice@example.com', role: 'write' });
    const bob = createEnv(db, harness, 'bob@example.com');
    const alice = createEnv(db, harness, 'alice@example.com');

    expect(
      (await call(bob, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'From Fork', baseBranch: 'main', headBranch: 'feat', headOwner: 'bob', headRepo: 'demo' }) })).status,
    ).toBe(400); // bob/demo has no feat branch
    harness.seed('bob/demo', { refs: [{ ref: 'refs/heads/main', oid: OID_B }, { ref: 'refs/heads/feat', oid: OID_B }], objects: [OID_B] });
    expect(
      (await call(bob, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'From Fork', baseBranch: 'main', headBranch: 'feat', headOwner: 'bob', headRepo: 'demo' }) })).status,
    ).toBe(201);

    const merged = await call(alice, '/user/repos/alice/demo/pulls/1/merge', { method: 'POST', headers: json, body: JSON.stringify({ deleteHead: true }) });
    expect(merged.status).toBe(200);
    await expect(merged.json()).resolves.toMatchObject({ pull: { status: 'merged' }, merge: { type: 'fast-forward' } });
    expect(harness.deletedBranches).toContainEqual({ repo: 'bob/demo', branch: 'feat' });
    // Same-repo merge arg shape still passes headBranch for non-cross PRs only.
    const mergeCall = harness.calls.find((c) => c.method === 'mergePull');
    expect(mergeCall?.args).toMatchObject({ baseBranch: 'main', headOid: OID_B });
    expect(mergeCall?.args).not.toHaveProperty('deleteHead');
  });

  it('merges without head deletion rights but reports deletedHead false', async () => {
    const db = createForkFakeDb();
    const harness = createGitHarness();
    seedForkWorld(db, harness);
    db.collabs.push({ repo_id: 'r1', user_email: 'carol@example.com', role: 'write' });
    const bob = createEnv(db, harness, 'bob@example.com');
    const carol = createEnv(db, harness, 'carol@example.com');

    expect(
      (await call(bob, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'From Fork', baseBranch: 'main', headBranch: 'main', headOwner: 'bob', headRepo: 'demo' }) })).status,
    ).toBe(201);
    // Carol can merge into the base but may not delete branches in bob's fork:
    // the merge proceeds and reports deletedHead: false.
    const res = await call(carol, '/user/repos/alice/demo/pulls/1/merge', { method: 'POST', headers: json, body: JSON.stringify({ deleteHead: true }) });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ pull: { status: 'merged' }, merge: { deletedHead: false } });
    expect(harness.deletedBranches).toHaveLength(0);
  });
});

describe('MergeService oid preview', () => {
  it('exposes getPreviewByOids for cross-DO use', async () => {
    const svc = new MergeService({} as never, '/repo');
    await expect(svc.getPreviewByOids('short', OID_A)).resolves.toBeNull();
  });
});
