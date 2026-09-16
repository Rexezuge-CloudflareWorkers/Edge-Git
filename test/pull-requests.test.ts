import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { PullRequestService } from '@edge-git/backend-services/pull';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
// NOTE: relative import bypasses packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node test env).
import { MergeService } from '../packages/git-service/src/MergeService';

// In-memory D1 fake covering pull_requests + the repo/user lookups services need.
function createPullFakeDb() {
  const state = {
    repos: [] as Array<Record<string, unknown>>,
    users: [] as Array<Record<string, unknown>>,
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
        if (q.includes('FROM repositories WHERE owner = ? AND name = ?')) {
          const row = state.repos.find((r) => r.owner === params[0] && r.name === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('COALESCE(MAX(number)') && q.includes('FROM pull_requests')) {
          const max = state.pulls.filter((p) => p.repository_id === params[0]).reduce((m, p) => Math.max(m, p.number as number), 0);
          return Promise.resolve({ max_n: max } as unknown as T);
        }
        if (q.includes('FROM pull_requests WHERE repository_id = ? AND number = ?')) {
          const row = state.pulls.find((p) => p.repository_id === params[0] && p.number === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE')) {
          const row = state.users.find((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase());
          return Promise.resolve((row ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
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
        if (q.startsWith('INSERT INTO pull_requests')) {
          const [id, repository_id, full_name, number, title, body, status, base_branch, head_branch, base_oid, head_oid, merge_base_oid, creator_email, created_at, updated_at] =
            params as Array<string | number | null>;
          state.pulls.push({ id, repository_id, full_name, number, title, body, status, base_branch, head_branch, base_oid, head_oid, merge_base_oid, creator_email, merged_by: null, merged_at: null, created_at, updated_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE pull_requests SET status = ?') && q.includes('merged_by')) {
          const [status, merged_by, merged_at, commitOid, updated_at, id] = params as Array<string | number | null>;
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
          const [id, pull_request_id, author_email, rstate, body, commit_oid, created_at] = params as Array<string | number | null>;
          state.reviews.push({ id, pull_request_id, author_email, state: rstate, body, commit_oid, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO pull_request_comments')) {
          const [id, pull_request_id, author_email, body, created_at] = params as Array<string | number>;
          state.comments.push({ id, pull_request_id, author_email, body, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO users')) {
          const [email, created_at] = params as Array<string | number>;
          if (!state.users.some((u) => u.email === email)) state.users.push({ email, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      },
    };
  }

  const db = { ...state, prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) };
  return db as unknown as D1Queryable & typeof state;
}

function seedRepo(db: D1Queryable & { repos: Array<Record<string, unknown>> }) {
  db.repos.push({
    id: 'r1',
    owner_email: 'alice@example.com',
    owner: 'alice',
    name: 'demo',
    description: null,
    is_private: 0,
    created_at: 1,
    updated_at: 2,
  });
}

describe('PullRequestService', () => {
  it('numbers PRs per repo and rejects same-branch PRs', async () => {
    const db = createPullFakeDb();
    const svc = new PullRequestService({ DB: db });
    const first = await svc.createPull({ repositoryId: 'r1', fullName: 'alice/demo', title: 'One', baseBranch: 'main', headBranch: 'feat', creatorEmail: 'a@x.com' });
    const second = await svc.createPull({ repositoryId: 'r1', fullName: 'alice/demo', title: 'Two', baseBranch: 'main', headBranch: 'feat2', creatorEmail: 'a@x.com' });
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    await expect(svc.createPull({ repositoryId: 'r1', fullName: 'alice/demo', title: 'Bad', baseBranch: 'main', headBranch: 'main', creatorEmail: 'a@x.com' })).rejects.toThrow(
      /must differ/,
    );
  });

  it('closes, reopens, and forbids merged transitions', async () => {
    const db = createPullFakeDb();
    const svc = new PullRequestService({ DB: db });
    await svc.createPull({ repositoryId: 'r1', fullName: 'a/b', title: 'T', baseBranch: 'main', headBranch: 'x', creatorEmail: 'a@x.com' });
    await expect(svc.updateStatus({ repositoryId: 'r1', number: 1, status: 'bogus' })).rejects.toThrow(/open or closed/);
    expect((await svc.updateStatus({ repositoryId: 'r1', number: 1, status: 'closed' })).status).toBe('closed');
    expect((await svc.updateStatus({ repositoryId: 'r1', number: 1, status: 'open' })).status).toBe('open');
  });

  it('blocks merge on changes_requested until approved', async () => {
    const db = createPullFakeDb();
    const svc = new PullRequestService({ DB: db });
    await svc.createPull({ repositoryId: 'r1', fullName: 'a/b', title: 'T', baseBranch: 'main', headBranch: 'x', creatorEmail: 'a@x.com' });
    await svc.addReview({ repositoryId: 'r1', number: 1, authorEmail: 'r@x.com', state: 'changes_requested', body: 'fix it' });
    await expect(svc.markMerged({ repositoryId: 'r1', number: 1, mergedBy: 'a@x.com', commitOid: 'c1' })).rejects.toThrow(/unresolved change requests/);
    await svc.addReview({ repositoryId: 'r1', number: 1, authorEmail: 'r@x.com', state: 'approved' });
    const merged = await svc.markMerged({ repositoryId: 'r1', number: 1, mergedBy: 'a@x.com', commitOid: 'c1' });
    expect(merged.status).toBe('merged');
    await expect(svc.updateStatus({ repositoryId: 'r1', number: 1, status: 'open' })).rejects.toThrow(/cannot be reopened/);
    await expect(svc.addReview({ repositoryId: 'r1', number: 1, authorEmail: 'r@x.com', state: 'commented' })).rejects.toThrow(/merged/);
  });

  it('validates reviews and comments', async () => {
    const db = createPullFakeDb();
    const svc = new PullRequestService({ DB: db });
    await svc.createPull({ repositoryId: 'r1', fullName: 'a/b', title: 'T', baseBranch: 'main', headBranch: 'x', creatorEmail: 'a@x.com' });
    await expect(svc.addReview({ repositoryId: 'r1', number: 1, authorEmail: 'r@x.com', state: 'nope' })).rejects.toThrow(/approved/);
    await expect(svc.addComment({ repositoryId: 'r1', number: 1, authorEmail: 'a@x.com', body: '   ' })).rejects.toThrow(/required/);
    const comment = await svc.addComment({ repositoryId: 'r1', number: 1, authorEmail: 'a@x.com', body: 'lgtm' });
    expect(comment.body).toBe('lgtm');
    expect(await svc.listComments('r1', 1)).toHaveLength(1);
  });

  it('resolves via request scope with injected DAO', async () => {
    const db = createPullFakeDb();
    const scope = createRequestScope({ DB: db });
    const svc = scope.get(Tokens.PullRequestService);
    expect(svc).toBeInstanceOf(PullRequestService);
    expect(scope.get(Tokens.PullRequestService)).toBe(svc);
  });
});

describe('Pull request API routes', () => {
  const OID_A = 'a'.repeat(40);
  const OID_B = 'b'.repeat(40);

  function createStub(overrides: Record<string, () => Promise<unknown>> = {}) {
    return {
      setFullName: () => Promise.resolve(),
      ensureRepoInitialized: () => Promise.resolve(),
      getMergePreview: () => Promise.resolve({ baseOid: OID_A, headOid: OID_B, mergeBase: OID_A, alreadyMerged: false, canFastForward: true }),
      getPullDiff: () => Promise.resolve({ mergeBase: OID_A, truncated: false, changes: [{ type: 'add', path: 'f.txt' }] }),
      mergePull: () => Promise.resolve({ type: 'fast-forward', commitOid: OID_B }),
      ...overrides,
    };
  }

  function createEnv(db: D1Queryable, stub: unknown, email: string) {
    return {
      DB: db,
      REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
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

  it('lets read users open PRs but reserves triage and merge for write+', async () => {
    const db = createPullFakeDb();
    seedRepo(db);
    const stub = createStub();
    const alice = createEnv(db, stub, 'alice@example.com');
    const bob = createEnv(db, stub, 'bob@example.com');

    // Bob has read on the public repo: can open, cannot triage or merge.
    const opened = await call(bob, '/user/repos/alice/demo/pulls', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'Bob Fix', baseBranch: 'main', headBranch: 'bob-fix' }),
    });
    expect(opened.status).toBe(201);

    expect((await call(bob, '/user/repos/alice/demo/pulls/1', { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'closed' }) })).status).toBe(403);
    expect((await call(bob, '/user/repos/alice/demo/pulls/1/merge', { method: 'POST', headers: json, body: '{}' })).status).toBe(403);

    // Same-branch PR is a 400, unknown branch is a 400.
    expect(
      (await call(alice, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Bad', baseBranch: 'main', headBranch: 'main' }) })).status,
    ).toBe(400);

    // Public read surface mirrors the PR.
    await expect(call(alice, '/repos/alice/demo/pulls').then((r) => r.json())).resolves.toMatchObject({ pulls: [{ number: 1 }] });
    await expect(call(alice, '/repos/alice/demo/pulls/1/diff').then((r) => r.json())).resolves.toMatchObject({ diff: { truncated: false } });
  });

  it('blocks merge while change requests are unresolved, then merges', async () => {
    const db = createPullFakeDb();
    seedRepo(db);
    const stub = createStub();
    const alice = createEnv(db, stub, 'alice@example.com');

    expect(
      (await call(alice, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Feat', baseBranch: 'main', headBranch: 'feat' }) })).status,
    ).toBe(201);
    expect(
      (await call(alice, '/user/repos/alice/demo/pulls/1/reviews', { method: 'POST', headers: json, body: JSON.stringify({ state: 'changes_requested', body: 'fix' }) })).status,
    ).toBe(201);

    const blocked = await call(alice, '/user/repos/alice/demo/pulls/1/merge', { method: 'POST', headers: json, body: '{}' });
    expect(blocked.status).toBe(409);

    expect(
      (await call(alice, '/user/repos/alice/demo/pulls/1/reviews', { method: 'POST', headers: json, body: JSON.stringify({ state: 'approved' }) })).status,
    ).toBe(201);
    const merged = await call(alice, '/user/repos/alice/demo/pulls/1/merge', { method: 'POST', headers: json, body: '{}' });
    expect(merged.status).toBe(200);
    await expect(merged.json()).resolves.toMatchObject({ pull: { status: 'merged' }, merge: { type: 'fast-forward' } });
  });

  it('surfaces merge conflicts as 409', async () => {
    const db = createPullFakeDb();
    seedRepo(db);
    const stub = createStub({ mergePull: () => Promise.resolve({ type: 'conflict', conflicts: ['a.txt'] }) });
    const alice = createEnv(db, stub, 'alice@example.com');

    expect(
      (await call(alice, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Feat', baseBranch: 'main', headBranch: 'feat' }) })).status,
    ).toBe(201);
    const res = await call(alice, '/user/repos/alice/demo/pulls/1/merge', { method: 'POST', headers: json, body: '{}' });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ conflicts: ['a.txt'] });
  });

  it('rejects invalid branch names before touching git', async () => {
    const db = createPullFakeDb();
    seedRepo(db);
    let previewCalls = 0;
    const stub = createStub({ getMergePreview: () => {
      previewCalls += 1;
      return Promise.resolve({ baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40), mergeBase: 'a'.repeat(40), alreadyMerged: false, canFastForward: true });
    } });
    const alice = createEnv(db, stub, 'alice@example.com');
    expect(PullRequestService.isValidBranchName('../escape')).toBe(false);
    expect(PullRequestService.isValidBranchName('main')).toBe(true);
    expect(PullRequestService.isValidBranchName('feat/nice-1')).toBe(true);

    const res = await call(alice, '/user/repos/alice/demo/pulls', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ title: 'Bad', baseBranch: '../escape', headBranch: 'feat' }),
    });
    expect(res.status).toBe(400);
    expect(previewCalls).toBe(0);
    await expect(new PullRequestService({ DB: db }).createPull({ repositoryId: 'r1', fullName: 'a/b', title: 'T', baseBranch: 'main', headBranch: 'main..x', creatorEmail: 'a@x.com' })).rejects.toThrow(
      /invalid branch/,
    );
  });

  it('exposes merge preview publicly and refreshes oids plus deleteHead on merge', async () => {
    const db = createPullFakeDb();
    seedRepo(db);
    const OID_A = 'a'.repeat(40);
    const OID_B = 'b'.repeat(40);
    const seen: Array<Record<string, unknown>> = [];
    const stub = createStub({
      getMergePreview: () => Promise.resolve({ baseOid: OID_A, headOid: OID_B, mergeBase: OID_A, alreadyMerged: false, canFastForward: true }),
      mergePull: ((args: unknown) => {
        seen.push(args as Record<string, unknown>);
        return Promise.resolve({ type: 'fast-forward', commitOid: OID_B, deletedHead: true });
      }) as () => Promise<unknown>,
    });
    const alice = createEnv(db, stub, 'alice@example.com');

    expect(
      (await call(alice, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Feat', baseBranch: 'main', headBranch: 'feat' }) })).status,
    ).toBe(201);
    // Public preview mirrors the authed preview without auth.
    await expect(call(alice, '/repos/alice/demo/pulls/1/preview').then((r) => r.json())).resolves.toMatchObject({ preview: { headOid: OID_B } });
    await expect(call(alice, '/user/repos/alice/demo/pulls/1/preview').then((r) => r.json())).resolves.toMatchObject({ preview: { headOid: OID_B } });

    const merged = await call(alice, '/user/repos/alice/demo/pulls/1/merge', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ deleteHead: true }),
    });
    expect(merged.status).toBe(200);
    await expect(merged.json()).resolves.toMatchObject({ pull: { status: 'merged' }, merge: { type: 'fast-forward', deletedHead: true } });
    // Default message uses PR number + title; head branch requested for deletion.
    expect(seen[0]).toMatchObject({ baseBranch: 'main', headBranch: 'feat', headOid: OID_B, deleteHead: true });
    expect(String((seen[0] as { message?: string }).message)).toContain('#1');
    // Stored oids were refreshed from git truth before merging.
    const svc = new PullRequestService({ DB: db });
    const stored = await svc.getByNumber('r1', 1);
    expect(stored.base_oid).toBe(OID_A);
    expect(stored.head_oid).toBe(OID_B);
    await expect(svc.refreshOids({ repositoryId: 'r1', number: 1, baseOid: OID_A })).resolves.toMatchObject({ status: 'merged' });
  });

  it('surfaces criss-cross reason in conflict payload', async () => {
    const db = createPullFakeDb();
    seedRepo(db);
    const stub = createStub({ mergePull: () => Promise.resolve({ type: 'conflict', conflicts: [], reason: 'criss-cross merges are not supported' }) });
    const alice = createEnv(db, stub, 'alice@example.com');
    expect(
      (await call(alice, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Feat', baseBranch: 'main', headBranch: 'feat' }) })).status,
    ).toBe(201);
    const res = await call(alice, '/user/repos/alice/demo/pulls/1/merge', { method: 'POST', headers: json, body: '{}' });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ reason: 'criss-cross merges are not supported' });
  });
});

describe('MergeService true merge', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function writeAndCommit(dir: string, filepath: string, content: string, message: string): Promise<string> {
    await fs.promises.writeFile(path.join(dir, filepath), content);
    await git.add({ fs, dir, filepath });
    return git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message });
  }

  async function makeRepo(): Promise<{ dir: string; gitdir: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-merge-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir, defaultBranch: 'main' });
    await writeAndCommit(dir, 'base.txt', 'base\n', 'init');
    return { dir, gitdir: path.join(dir, '.git') };
  }

  function mergerFor(gitdir: string): MergeService {
    return new MergeService(fs as never, gitdir, path.join(os.tmpdir(), 'edge-git-merge-wd'));
  }

  it('fast-forwards when head is strictly ahead', async () => {
    const { dir, gitdir } = await makeRepo();
    await git.branch({ fs, dir, ref: 'feat', checkout: true });
    const headOid = await writeAndCommit(dir, 'feat.txt', 'feat\n', 'feat commit');
    await git.checkout({ fs, dir, ref: 'main' });
    const svc = mergerFor(gitdir);
    const preview = await svc.getPreview('refs/heads/main', 'refs/heads/feat');
    expect(preview?.canFastForward).toBe(true);
    const outcome = await svc.mergeBranches({ baseBranch: 'main', headOid, author: { name: 'tester', email: 'tester@example.com' } });
    expect(outcome).toMatchObject({ type: 'fast-forward', commitOid: headOid });
    expect(await svc.resolveRef('refs/heads/main')).toBe(headOid);
  });

  it('creates a merge commit for divergent branches', async () => {
    const { dir, gitdir } = await makeRepo();
    await git.branch({ fs, dir, ref: 'feat', checkout: true });
    const headOid = await writeAndCommit(dir, 'feat.txt', 'feat\n', 'feat commit');
    await git.checkout({ fs, dir, ref: 'main' });
    await writeAndCommit(dir, 'main.txt', 'main\n', 'main commit');
    const svc = mergerFor(gitdir);
    const preview = await svc.getPreview('refs/heads/main', 'refs/heads/feat');
    expect(preview?.canFastForward).toBe(false);
    expect(preview?.alreadyMerged).toBe(false);
    const outcome = await svc.mergeBranches({
      baseBranch: 'main',
      headOid,
      author: { name: 'tester', email: 'tester@example.com' },
      message: 'Merge pull request #1: Feat',
    });
    expect(outcome.type).toBe('merge-commit');
    const commitOid = (outcome as { commitOid: string }).commitOid;
    const commit = await git.readCommit({ fs, dir, oid: commitOid });
    expect(commit.commit.parent).toHaveLength(2);
    expect(commit.commit.message).toContain('#1');
  });

  it('reports already-merged and conflicts', async () => {
    const { dir, gitdir } = await makeRepo();
    const svc = mergerFor(gitdir);
    const mainOid = await svc.resolveRef('refs/heads/main');
    expect(mainOid).toBeTruthy();
    await expect(svc.mergeBranches({ baseBranch: 'main', headOid: mainOid as string, author: { name: 't', email: 't@x.com' } })).resolves.toMatchObject({
      type: 'already-merged',
    });
    await expect(svc.mergeBranches({ baseBranch: 'nope', headOid: 'a'.repeat(40), author: { name: 't', email: 't@x.com' } })).rejects.toThrow(/base branch not found/);
    await expect(svc.mergeBranches({ baseBranch: 'main', headOid: 'short', author: { name: 't', email: 't@x.com' } })).rejects.toThrow(/invalid head oid/);
    await expect(svc.mergeBranches({ baseBranch: '../x', headOid: 'a'.repeat(40), author: { name: 't', email: 't@x.com' } })).rejects.toThrow(/invalid base branch/);

    // Conflicting edit to the same file on both branches.
    await git.branch({ fs, dir, ref: 'feat', checkout: true });
    await writeAndCommit(dir, 'base.txt', 'feat version\n', 'feat edit');
    const featOid = await git.resolveRef({ fs, dir, ref: 'feat' });
    await git.checkout({ fs, dir, ref: 'main' });
    await writeAndCommit(dir, 'base.txt', 'main version\n', 'main edit');
    const conflict = await svc.mergeBranches({ baseBranch: 'main', headOid: featOid, author: { name: 't', email: 't@x.com' } });
    expect(conflict.type).toBe('conflict');
    expect((conflict as { conflicts: string[] }).conflicts).toContain('base.txt');
  });

  it('deletes head branches', async () => {
    const { dir, gitdir } = await makeRepo();
    await git.branch({ fs, dir, ref: 'feat', checkout: false });
    const svc = mergerFor(gitdir);
    await svc.deleteBranch('feat');
    expect(await git.listBranches({ fs, dir })).not.toContain('feat');
    await expect(svc.deleteBranch('../escape')).rejects.toThrow(/invalid branch/);
  });
});
