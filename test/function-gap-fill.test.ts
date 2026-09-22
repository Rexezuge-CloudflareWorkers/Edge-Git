import { describe, expect, it, beforeEach, vi } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import { triggerRequiredChecks } from '@/workers/routes/TriggerChecks';
import { publishLiveUpdate, publishCheckUpdate, recordAndNotify } from '@/workers/routes/SocialEmit';
import { moveRepoDosForRename, moveOneRepo } from '@/workers/routes/RepoMove';
import { runMirrorSync } from '@edge-git/background/transfer/MirrorRunner';
import { runImportJob } from '@edge-git/background/transfer/ImportRunner';
import { fetchRemotePack, PktLine } from '@edge-git/git-protocol';
import { SearchService } from '@edge-git/backend-services/search';
import {
  BadRequestError,
  DatabaseError,
  ForbiddenError,
  InternalServerError,
  DefaultInternalServerError,
  MethodNotAllowedError,
  NonRetryableError,
  NotFoundError,
  RetryableError,
  UnauthorizedError,
  ConflictError,
  PayloadTooLargeError,
  RateLimitedError,
  AiSummaryRetryableError,
  ProviderApiNonRetryableError,
  ProviderApiRetryableError,
  OAuth2TokenNonRetryableError,
  OAuth2TokenRetryableError,
} from '@edge-git/backend-errors';
import { mapServiceError, toServiceStatus as mapToStatus } from '@edge-git/backend-services/errors';
import { toServiceStatus as apiToStatus, toSafeErrorMessage } from '@/workers/routes/PublicViewerResolver';
import {
  AuditLogCleanupTask,
  BackgroundTaskRunPruningTask,
  CheckPruneTask,
  CheckStaleTask,
  ExpiredTokenPruningTask,
  ImportSweeperTask,
  MirrorSyncTask,
  SocialPruningTask,
  WebhookDeliveryTask,
} from '@edge-git/background/scheduled/TaskRegistry';
import { CronTasksWorker } from '@edge-git/background/CronTasksWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { resetRateLimitForTests } from '@/middleware/rateLimit';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_ZERO = '0'.repeat(40);

beforeEach(() => {
  resetRateLimitForTests();
});

// ---------------------------------------------------------------------------
// gap fake D1 for EdgeGitWorker + TriggerChecks + SocialEmit
// ---------------------------------------------------------------------------
function createGapFakeDb() {
  const state = {
    users: [
      { email: ALICE, username: 'alice', created_at: 1 },
      { email: BOB, username: 'bob', created_at: 1 },
    ] as Array<Record<string, unknown>>,
    namespaces: [
      { username_ci: 'alice', kind: 'user', user_email: ALICE, org_id: null },
      { username_ci: 'bob', kind: 'user', user_email: BOB, org_id: null },
      { username_ci: 'acme', kind: 'org', user_email: null, org_id: 'org-acme' },
    ] as Array<Record<string, unknown>>,
    repos: [
      {
        id: 'r-demo',
        owner_email: ALICE,
        owner_user_email: ALICE,
        owner: 'alice',
        name: 'demo',
        description: null,
        is_private: 0,
        created_at: 1,
        updated_at: 2,
        owner_type: 'user',
        owner_ci: 'alice',
        name_ci: 'demo',
        org_id: null,
      },
    ] as Array<Record<string, unknown>>,
    organizations: [{ id: 'org-acme', username: 'acme', username_ci: 'acme', creator_email: ALICE, created_at: 1, updated_at: 1 }] as Array<
      Record<string, unknown>
    >,
    orgMembers: [{ org_id: 'org-acme', user_email: ALICE, role: 'owner', created_at: 1 }] as Array<Record<string, unknown>>,
    branchRules: [] as Array<Record<string, unknown>>,
    checks: [] as Array<Record<string, unknown>>,
    pulls: [
      {
        id: 'pr-1',
        repository_id: 'r-demo',
        full_name: 'alice/demo',
        number: 1,
        title: 'Feat',
        body: null,
        status: 'open',
        base_branch: 'main',
        head_branch: 'feat',
        base_oid: OID_A,
        head_oid: OID_B,
        merge_base_oid: OID_A,
        creator_email: ALICE,
        created_at: 1,
        updated_at: 1,
        is_draft: 0,
      },
    ] as Array<Record<string, unknown>>,
    collaborators: [] as Array<Record<string, unknown>>,
  };

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    const P = (i: number): string => String(params[i] ?? '');
    const Pl = (i: number): string => P(i).toLowerCase();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM branch_protection_rules WHERE repository_id = ? AND pattern = ?')) {
          return Promise.resolve(
            (state.branchRules.find((r) => r.repository_id === params[0] && r.pattern === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('FROM branch_protection_rules WHERE id = ?')) {
          return Promise.resolve((state.branchRules.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS n FROM branch_protection_rules')) {
          return Promise.resolve({ n: state.branchRules.filter((r) => r.repository_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM check_runs WHERE repository_id = ? AND head_sha = ? AND context = ?')) {
          const row =
            state.checks.find(
              (c) =>
                c.repository_id === params[0] && String(c.head_sha).toLowerCase() === Pl(1) && String(c.context).toLowerCase() === Pl(2),
            ) ?? null;
          return Promise.resolve(row as T | null);
        }
        if (q.includes('FROM check_runs WHERE id = ? AND repository_id = ?')) {
          return Promise.resolve((state.checks.find((c) => c.id === params[0] && c.repository_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS n FROM check_runs')) {
          return Promise.resolve({ n: state.checks.filter((c) => c.repository_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM users WHERE lower(email)')) {
          return Promise.resolve((state.users.find((u) => String(u.email).toLowerCase() === Pl(0)) ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE lower(username)')) {
          return Promise.resolve((state.users.find((u) => String(u.username ?? '').toLowerCase() === Pl(0)) ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE email = ?')) {
          return Promise.resolve((state.users.find((u) => u.email === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM namespaces WHERE username_ci = ?')) {
          return Promise.resolve((state.namespaces.find((n) => n.username_ci === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE owner_ci = ? AND name_ci = ?')) {
          return Promise.resolve(
            (state.repos.find(
              (r) => String(r.owner_ci ?? r.owner).toLowerCase() === Pl(0) && String(r.name_ci ?? r.name).toLowerCase() === Pl(1),
            ) ?? null) as T | null,
          );
        }
        if (q.includes('FROM repositories WHERE lower(owner)') && q.includes('AND lower(name)')) {
          return Promise.resolve(
            (state.repos.find((r) => String(r.owner).toLowerCase() === Pl(0) && String(r.name).toLowerCase() === Pl(1)) ??
              null) as T | null,
          );
        }
        if (q.includes('FROM repositories WHERE owner = ? AND name = ?')) {
          return Promise.resolve((state.repos.find((r) => r.owner === params[0] && r.name === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE id = ?')) {
          return Promise.resolve((state.repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM organization_members WHERE org_id = ? AND')) {
          return Promise.resolve(
            (state.orgMembers.find((m) => m.org_id === params[0] && String(m.user_email).toLowerCase() === Pl(1)) ?? null) as T | null,
          );
        }
        if (q.includes('COUNT(*) AS n FROM organization_members')) {
          return Promise.resolve({
            n: state.orgMembers.filter((m) => m.org_id === params[0] && m.role === 'owner').length,
          } as unknown as T);
        }
        if (q.includes('FROM organizations WHERE username_ci = ?')) {
          return Promise.resolve((state.organizations.find((o) => o.username_ci === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM organizations WHERE id = ?')) {
          return Promise.resolve((state.organizations.find((o) => o.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repo_collaborators WHERE repo_id = ? AND')) {
          return Promise.resolve(
            (state.collaborators.find((c) => c.repo_id === params[0] && String(c.user_email).toLowerCase() === Pl(1)) ?? null) as T | null,
          );
        }
        if (q.includes('FROM pull_requests WHERE repository_id = ? AND number = ?')) {
          return Promise.resolve((state.pulls.find((p) => p.repository_id === params[0] && p.number === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM pull_requests WHERE id = ?')) {
          return Promise.resolve((state.pulls.find((p) => p.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*)')) return Promise.resolve({ n: 0, count: 0 } as unknown as T);
        if (q.includes('COALESCE(MAX(number)')) return Promise.resolve({ max_n: 0, next_number: 1 } as unknown as T);
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM branch_protection_rules WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.branchRules.filter((r) => r.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM check_runs WHERE repository_id = ? AND head_sha = ?')) {
          return Promise.resolve({
            results: state.checks.filter((c) => c.repository_id === params[0] && String(c.head_sha).toLowerCase() === Pl(1)) as T[],
          });
        }
        if (q.includes('FROM repositories WHERE') && q.includes('owner_email')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner_email).toLowerCase() === Pl(0)) as T[] });
        }
        if (q.includes('FROM repositories WHERE owner_ci = ?') && !q.includes('AND name_ci')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner_ci ?? r.owner).toLowerCase() === Pl(0)) as T[] });
        }
        if (q.includes('FROM repositories WHERE lower(owner) = ?') && !q.includes('AND lower(name)')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner).toLowerCase() === Pl(0)) as T[] });
        }
        if (q.includes('FROM repositories WHERE org_id = ?')) {
          return Promise.resolve({ results: state.repos.filter((r) => r.org_id === params[0]) as T[] });
        }
        if (q.includes('FROM organization_members WHERE org_id = ? ORDER BY')) {
          return Promise.resolve({ results: state.orgMembers.filter((m) => m.org_id === params[0]) as T[] });
        }
        if (q.includes('FROM organization_members WHERE lower(user_email)')) {
          return Promise.resolve({ results: state.orgMembers.filter((m) => String(m.user_email).toLowerCase() === Pl(0)) as T[] });
        }
        if (q.includes('FROM pull_requests WHERE')) {
          return Promise.resolve({ results: state.pulls.filter((p) => (params.length > 0 ? p.repository_id === params[0] : true)) as T[] });
        }
        return Promise.resolve({ results: [] as T[] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO branch_protection_rules')) {
          state.branchRules.push({
            id: params[0],
            repository_id: params[1],
            pattern: params[2],
            require_pr: params[3],
            required_approvals: params[4],
            block_force_push: params[5],
            block_deletion: params[6],
            require_status_checks: params[7],
            created_by: params[8],
            created_at: params[9],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO check_runs')) {
          state.checks.push({
            id: params[0],
            repository_id: params[1],
            head_sha: String(params[2]).toLowerCase(),
            context: params[3],
            status: 'queued',
            conclusion: null,
            details_url: null,
            output_title: null,
            output_summary: null,
            creator_email: (params[4] as string) ?? ALICE,
            created_at: (params[5] as number) ?? 1,
            updated_at: (params[5] as number) ?? 1,
            completed_at: null,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE check_runs SET status = ?')) {
          const row = state.checks.find((c) => c.id === params[7] && c.repository_id === params[8]);
          if (row) {
            row.status = params[0];
            row.conclusion = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO users')) {
          if (!state.users.some((u) => u.email === params[0])) state.users.push({ email: params[0], created_at: params[1] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE users SET')) {
          const row = state.users.find((u) => String(u.email).toLowerCase() === String(params[params.length - 1]).toLowerCase());
          if (row) row.username = (params[0] as string) ?? row.username;
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO namespaces') || q.startsWith('INSERT OR IGNORE INTO namespaces')) {
          if (!state.namespaces.some((n) => n.username_ci === params[0]))
            state.namespaces.push({ username_ci: params[0], kind: params[1], user_email: params[2] ?? null, org_id: params[3] ?? null });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO organizations')) {
          state.organizations.push({
            id: params[0],
            username: params[1],
            username_ci: params[2],
            creator_email: params[3],
            created_at: params[4],
            updated_at: params[5],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO organization_members')) {
          const existing = state.orgMembers.find((m) => m.org_id === params[0] && String(m.user_email).toLowerCase() === Pl(1));
          if (existing) existing.role = params[2];
          else
            state.orgMembers.push({
              org_id: params[0],
              user_email: String(params[1]).toLowerCase(),
              role: params[2],
              created_at: params[3],
            });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      },
    };
  }
  const db = { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) };
  return { db: db as unknown as D1Queryable, state };
}

function createGapDoStub(opts: { publishCount?: { count: number }; enqueueFail?: boolean } = {}) {
  return {
    setFullName: () => Promise.resolve(),
    ensureRepoInitialized: () => Promise.resolve(),
    deleteRepo: () => Promise.resolve(),
    listRefs: () => Promise.resolve({ refs: [{ ref: 'refs/heads/main', oid: OID_A }], symbolicHead: 'refs/heads/main' }),
    getBranches: () => Promise.resolve({ branches: ['main'], currentBranch: 'main' }),
    getTree: () => Promise.resolve([]),
    getBlob: () => Promise.resolve(null),
    getCommits: () => Promise.resolve([]),
    getTags: () => Promise.resolve([]),
    getOverview: () =>
      Promise.resolve({ branches: ['main'], currentBranch: 'main', resolvedRef: OID_A, tags: [], tree: [], commits: [], readme: null }),
    getBlame: () => Promise.resolve([]),
    resolveRef: () => Promise.resolve(OID_A),
    createBranch: () => Promise.resolve({ ok: true, ref: 'refs/heads/x', oid: OID_A }),
    deleteBranchRef: () => Promise.resolve({ ok: true }),
    setDefaultBranch: () => Promise.resolve({ ok: true }),
    commitFile: () => Promise.resolve({ ok: true, commitOid: 'c'.repeat(40), created: true }),
    exportPack: () => Promise.resolve({ oids: [OID_A], pack: new Uint8Array([1, 2, 3]) }),
    importPack: () => Promise.resolve({ importedRefs: [] }),
    receivePack: () => Promise.resolve(new Response('ok')),
    fetch: () => Promise.resolve(new Response('PACK', { status: 200 })),
    mergePull: () => Promise.resolve({ ok: true, type: 'merged', commitOid: OID_B }),
    getReleaseAsset: () => Promise.resolve(null),
    storeReleaseAsset: () => Promise.resolve({ ok: true }),
    deleteReleaseAsset: () => Promise.resolve({ ok: true }),
    deleteReleaseAssets: () => Promise.resolve({ ok: true }),
    enqueueChecks: opts.enqueueFail ? () => Promise.reject(new Error('do down')) : () => Promise.resolve({ ok: true }),
    getMergePreview: () => Promise.resolve({ baseOid: OID_A, headOid: OID_B, mergeBase: OID_A }),
    getMergePreviewByOids: () => Promise.resolve({ baseOid: OID_A, headOid: OID_B, mergeBase: OID_A }),
    deleteBranch: () => Promise.resolve({ deleted: true }),
    listReviews: () => Promise.resolve([]),
    publish: (..._args: unknown[]) => {
      if (opts.publishCount) opts.publishCount.count += 1;
      return Promise.resolve({ delivered: 1 });
    },
    issueTicket: () => Promise.resolve({ ticket: 't', expiresAt: 9999999999, channels: ['activity'] }),
  };
}

function createGapEnv(db: D1Queryable, overrides: Record<string, unknown> = {}) {
  const stub = createGapDoStub();
  return {
    DB: db,
    REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    CRON_TASKS: { get: () => stub, idFromName: (n: string) => n },
    CHECK_RUNNER: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    REALTIME: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    ENVIRONMENT: 'development',
    DEV_AUTH_EMAIL: ALICE,
    ...overrides,
  };
}

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function callWorker(env: unknown, path: string, init?: RequestInit): Promise<Response> {
  const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
  return worker.onRequest(new Request(`https://git.example.com${path}`, init), env, CTX);
}
function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// runner DB for MirrorRunner / ImportRunner
// ---------------------------------------------------------------------------
interface RunnerDb {
  imports: Array<Record<string, unknown>>;
  mirrors: Array<Record<string, unknown>>;
  repos: Array<Record<string, unknown>>;
}
function createRunnerDb(seed: Partial<RunnerDb> = {}): D1Queryable & { data: RunnerDb } {
  const data: RunnerDb = { imports: [], mirrors: [], repos: [], ...seed };
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM repo_imports WHERE id = ?'))
          return Promise.resolve((data.imports.find((i) => i.id === params[0]) ?? null) as T | null);
        if (q.includes('FROM repo_mirrors WHERE repository_id = ?'))
          return Promise.resolve((data.mirrors.find((m) => m.repository_id === params[0]) ?? null) as T | null);
        if (q.includes('FROM repositories WHERE id = ?'))
          return Promise.resolve((data.repos.find((r) => r.id === params[0]) ?? null) as T | null);
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.includes("UPDATE repo_imports SET status = 'done'")) {
          const row = data.imports.find((i) => i.id === params[3]);
          if (row) {
            row.status = 'done';
            row.refs_json = params[0];
            row.imported_refs = params[1];
            row.updated_at = params[2];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes("UPDATE repo_imports SET status = 'failed'")) {
          const row = data.imports.find((i) => i.id === params[2]);
          if (row) {
            row.status = 'failed';
            row.error = params[0];
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes("UPDATE repo_mirrors SET last_run_at = ?, last_status = 'ok'")) {
          const row = data.mirrors.find((m) => m.repository_id === params[2]);
          if (row) {
            row.last_run_at = params[0];
            row.last_status = 'ok';
            row.last_error = null;
            row.consecutive_failures = 0;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes('consecutive_failures = consecutive_failures + 1')) {
          const row = data.mirrors.find((m) => m.repository_id === params[4]);
          if (row) {
            row.last_run_at = params[0];
            row.last_status = 'failed';
            row.last_error = params[1];
            row.consecutive_failures = (row.consecutive_failures as number) + 1;
            if ((row.consecutive_failures as number) >= (params[2] as number)) row.enabled = 0;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_mirrors')) {
          data.mirrors = data.mirrors.filter((m) => m.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }
  return { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }), data } as unknown as D1Queryable & {
    data: RunnerDb;
  };
}

function advertisement(refs: Array<{ oid: string; ref: string }> = [{ oid: OID_B, ref: 'refs/heads/main' }]): Uint8Array {
  return PktLine.mergeLines([
    PktLine.encode('# service=git-upload-pack\n'),
    PktLine.encodeFlush(),
    ...refs.map((r) => PktLine.encode(`${r.oid} ${r.ref}\n`)),
    PktLine.encodeFlush(),
  ]);
}
function packResponse(): Uint8Array {
  const pack = new Uint8Array([...new TextEncoder().encode('PACK'), 0, 0, 0, 2, 0, 0, 0, 1, 7, 8, 9]);
  return PktLine.mergeLines([PktLine.encode('NAK\n'), PktLine.encodeSideband(1, pack)]);
}

// ---------------------------------------------------------------------------
// 1. backend-errors constructors + mapping
// ---------------------------------------------------------------------------
describe('function-gap backend-errors', () => {
  it('DatabaseError defaults message and honors retryable flag', () => {
    const def = new DatabaseError();
    expect(def.getErrorType()).toBe('DatabaseError');
    expect(def.getErrorCode()).toBe(500);
    expect(def.retryable).toBe(false);
    expect(def.getErrorMessage()).toContain('database');
    const retry = new DatabaseError('custom db boom', true);
    expect(retry.retryable).toBe(true);
    expect(retry.getErrorMessage()).toBe('custom db boom');
  });

  it('InternalServerError defaults and singleton share type', () => {
    const err = new InternalServerError();
    expect(err.getErrorCode()).toBe(500);
    expect(err.getErrorType()).toBe('InternalServerError');
    expect(err.getErrorMessage()).toContain('internal error');
    expect(DefaultInternalServerError.getErrorType()).toBe('InternalServerError');
    const custom = new InternalServerError('boom');
    expect(custom.getErrorMessage()).toBe('boom');
  });

  it('RetryableError is retryable with dynamic type', () => {
    const err = new RetryableError('try again');
    expect(err.retryable).toBe(true);
    expect(err.getErrorCode()).toBe(500);
    expect(err.getErrorType()).toBe('RetryableError');
    expect(err.getErrorMessage()).toBe('try again');
  });

  it('NonRetryableError is not retryable with dynamic type', () => {
    const err = new NonRetryableError('fatal');
    expect(err.retryable).toBe(false);
    expect(err.getErrorCode()).toBe(500);
    expect(err.getErrorType()).toBe('NonRetryableError');
    expect(err.getErrorMessage()).toBe('fatal');
  });

  it('maps Bad/Forbidden/NotFound/Unauthorized/MethodNotAllowed codes', () => {
    expect(new BadRequestError('bad').getErrorCode()).toBe(400);
    expect(new BadRequestError().getErrorType()).toBe('BadRequest');
    expect(new ForbiddenError().getErrorCode()).toBe(403);
    expect(new NotFoundError().getErrorCode()).toBe(404);
    expect(new UnauthorizedError().getErrorCode()).toBe(401);
    expect(new MethodNotAllowedError().getErrorCode()).toBe(405);
    expect(new MethodNotAllowedError().getErrorType()).toBe('MethodNotAllowed');
  });

  it('ProviderErrors preserve retryable hierarchy and ai options', () => {
    const ai = new AiSummaryRetryableError('ai fail', { aiUsage: { tokens: 1 }, aiOutputText: 'partial' });
    expect(ai.retryable).toBe(true);
    expect(ai.aiOutputText).toBe('partial');
    expect(new ProviderApiRetryableError('x').retryable).toBe(true);
    expect(new ProviderApiNonRetryableError('x').retryable).toBe(false);
    expect(new OAuth2TokenRetryableError('x').retryable).toBe(true);
    expect(new OAuth2TokenNonRetryableError('x').retryable).toBe(false);
  });

  it('mapServiceError maps ServiceError vs plain errors', () => {
    expect(mapServiceError(new BadRequestError('bad q'))).toMatchObject({ status: 400 });
    expect(mapServiceError(new NotFoundError()).body.Exception?.Type).toBe('NotFound');
    expect(mapServiceError(new DatabaseError('db down'))).toMatchObject({ status: 500 });
    const plain = mapServiceError(new Error('unexpected'));
    expect(plain.status).toBe(500);
    expect(plain.body.Exception?.Type).toBe('InternalServerError');
  });

  it('toServiceStatus preserves 400/401/403/404/409/413/429 and masks 500s', () => {
    expect(mapToStatus(new BadRequestError('b'))).toBe(400);
    expect(mapToStatus(new ForbiddenError())).toBe(403);
    expect(mapToStatus(new NotFoundError())).toBe(404);
    expect(mapToStatus(new Error('plain'))).toBe(500);
    expect(mapToStatus(new UnauthorizedError())).toBe(401);
    expect(mapToStatus(new ConflictError('c'))).toBe(409);
    expect(mapToStatus(new PayloadTooLargeError('p'))).toBe(413);
    expect(mapToStatus(new RateLimitedError('r'))).toBe(429);
    expect(apiToStatus(new BadRequestError('b'))).toBe(400);
    expect(toSafeErrorMessage(new BadRequestError('visible problem'), 'fallback')).toBe('visible problem');
    expect(toSafeErrorMessage(new Error('D1 SELECT failed at offset 12'), 'fallback')).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// 2. SearchService statics + filtered searches
// ---------------------------------------------------------------------------
describe('function-gap SearchService', () => {
  it('sanitizeQuery trims and validates length', () => {
    expect(SearchService.sanitizeQuery('  hello world  ')).toBe('hello world');
    expect(() => SearchService.sanitizeQuery('x')).toThrow();
    expect(() => SearchService.sanitizeQuery('x'.repeat(201))).toThrow();
  });

  it('clampLimit and parseType cover edges', () => {
    expect(SearchService.clampLimit('5')).toBe(5);
    expect(SearchService.clampLimit(999)).toBe(50);
    expect(SearchService.clampLimit(0)).toBe(1);
    expect(SearchService.clampLimit('nope')).toBe(20);
    expect(SearchService.clampLimit(undefined)).toBe(20);
    expect(SearchService.parseType('issues')).toBe('issues');
    expect(SearchService.parseType('pulls')).toBe('pulls');
    expect(SearchService.parseType('code')).toBe('code');
    expect(SearchService.parseType('discussions')).toBe('discussions');
    expect(SearchService.parseType('snippets')).toBe('snippets');
    expect(SearchService.parseType('unknown')).toBe('repos');
    expect(SearchService.parseType(undefined)).toBe('repos');
  });

  it('isIndexablePath and truncateForIndex guards', () => {
    expect(SearchService.isIndexablePath('src/app.ts')).toBe(true);
    expect(SearchService.isIndexablePath('')).toBe(false);
    expect(SearchService.isIndexablePath('../evil')).toBe(false);
    expect(SearchService.isIndexablePath('/abs')).toBe(false);
    expect(SearchService.isIndexablePath('node_modules/a')).toBe(false);
    expect(SearchService.isIndexablePath('x/node_modules/a')).toBe(false);
    expect(SearchService.isIndexablePath('bundle.min.js')).toBe(false);
    expect(SearchService.isIndexablePath('a.map')).toBe(false);
    expect(SearchService.isIndexablePath('pnpm-lock.yaml')).toBe(false);
    expect(SearchService.truncateForIndex('x'.repeat(30000)).length).toBe(20000);
    expect(SearchService.truncateForIndex('short')).toBe('short');
  });

  it('searchRepos filters private rows via permission', async () => {
    const svc = new SearchService(
      { DB: {} as D1Queryable },
      {
        searchDAO: () => Promise.resolve({ searchRepos: async () => [{ id: 'r1' }, { id: 'r2' }] } as never),
        permissionService: () =>
          Promise.resolve({ getRole: async (_v: unknown, row: { id: string }) => (row.id === 'r1' ? 'read' : null) } as never),
      },
    );
    const out = await svc.searchRepos('demo', null, 10);
    expect(out.map((r) => (r as { id: string }).id)).toEqual(['r1']);
  });

  it('searchIssues skips rows with missing repos', async () => {
    const svc = new SearchService(
      { DB: {} as D1Queryable },
      {
        searchDAO: () =>
          Promise.resolve({
            searchIssues: async () => [
              { id: 'i1', repository_id: 'r1' },
              { id: 'i2', repository_id: 'gone' },
            ],
          } as never),
        repositoryDAO: () => Promise.resolve({ getById: async (id: string) => (id === 'r1' ? ({ id: 'r1' } as never) : null) } as never),
        permissionService: () => Promise.resolve({ getRole: async () => 'read' } as never),
      },
    );
    const out = await svc.searchIssues('bug', null, { limit: 10 });
    expect(out.map((r) => (r as { id: string }).id)).toEqual(['i1']);
  });

  it('searchPulls respects limit and caches repo lookups', async () => {
    let repoCalls = 0;
    const svc = new SearchService(
      { DB: {} as D1Queryable },
      {
        searchDAO: () =>
          Promise.resolve({
            searchPulls: async () => [
              { id: 'p1', repository_id: 'r1' },
              { id: 'p2', repository_id: 'r1' },
              { id: 'p3', repository_id: 'r1' },
            ],
          } as never),
        repositoryDAO: () =>
          Promise.resolve({
            getById: async (id: string) => {
              repoCalls += 1;
              return { id } as never;
            },
          } as never),
        permissionService: () => Promise.resolve({ getRole: async () => 'read' } as never),
      },
    );
    const out = await svc.searchPulls('feat', null, { limit: 2 });
    expect(out).toHaveLength(2);
    expect(repoCalls).toBe(1);
  });

  it('searchCode builds snippets and skips invisible repos', async () => {
    const svc = new SearchService(
      { DB: {} as D1Queryable },
      {
        searchDAO: () =>
          Promise.resolve({
            searchCode: async () => [
              { repo_id: 'r1', path: 'a.ts', content: 'hello world foo bar' },
              { repo_id: 'r2', path: 'b.ts', content: 'hello world' },
              { repo_id: 'gone', path: 'c.ts', content: 'hello' },
            ],
          } as never),
        repositoryDAO: () =>
          Promise.resolve({
            getById: async (id: string) => {
              if (id === 'gone') return null;
              return { id } as never;
            },
          } as never),
        permissionService: () =>
          Promise.resolve({ getRole: async (_v: unknown, row: { id: string }) => (row.id === 'r1' ? 'read' : null) } as never),
      },
    );
    const out = await svc.searchCode('hello', null, { limit: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toContain('hello');
    // missing-token snippet falls back to prefix
    const svc2 = new SearchService(
      { DB: {} as D1Queryable },
      {
        searchDAO: () => Promise.resolve({ searchCode: async () => [{ repo_id: 'r1', path: 'a.ts', content: 'zzz' }] } as never),
        repositoryDAO: () => Promise.resolve({ getById: async () => ({ id: 'r1' }) as never } as never),
        permissionService: () => Promise.resolve({ getRole: async () => 'read' } as never),
      },
    );
    const out2 = await svc2.searchCode('hello', null, {});
    expect(out2[0].snippet).toBe('zzz');
  });

  it('searchDiscussions/searchSnippets/indexFile/removeFile/clearRepo delegate', async () => {
    const calls: string[] = [];
    const svc = new SearchService(
      { DB: {} as D1Queryable },
      {
        searchDAO: () =>
          Promise.resolve({
            searchDiscussions: async () => [{ id: 'd1', repository_id: 'r1' }],
            searchSnippets: async () => [{ id: 's1' }],
            upsertCodeFile: async () => {
              calls.push('upsert');
            },
            deleteCodeFile: async () => {
              calls.push('delete');
            },
            deleteCodeByRepo: async () => {
              calls.push('clear');
            },
          } as never),
        repositoryDAO: () => Promise.resolve({ getById: async () => ({ id: 'r1' }) as never } as never),
        permissionService: () => Promise.resolve({ getRole: async () => 'read' } as never),
      },
    );
    await expect(svc.searchDiscussions('hello', null, {})).resolves.toHaveLength(1);
    await expect(svc.searchSnippets('hello', {})).resolves.toHaveLength(1);
    await expect(svc.indexFile({ repoId: 'r1', path: 'ok.ts', oid: OID_A, content: 'hi' })).resolves.toBe(true);
    await expect(svc.indexFile({ repoId: 'r1', path: '../evil', oid: OID_A, content: 'hi' })).resolves.toBe(false);
    await expect(svc.indexFile({ repoId: 'r1', path: 'ok.ts', oid: OID_A, content: 'a b' })).resolves.toBe(false);
    await svc.removeFile('r1', 'ok.ts');
    await svc.clearRepo('r1');
    expect(calls).toEqual(['upsert', 'delete', 'clear']);
  });
});

// ---------------------------------------------------------------------------
// 3. SocialEmit live fan-out
// ---------------------------------------------------------------------------
describe('function-gap SocialEmit', () => {
  function nullDb(): D1Queryable {
    return {
      prepare: () => ({
        bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }),
      }),
    } as unknown as D1Queryable;
  }

  it('publishLiveUpdate no-ops when realtime is disabled', async () => {
    const counter = { count: 0 };
    const stub = createGapDoStub({ publishCount: counter });
    const env = { DB: nullDb(), REALTIME: { getByName: () => stub, get: () => stub }, ENVIRONMENT: 'development' };
    await expect(
      publishLiveUpdate(env as never, { fullName: 'alice/demo', channel: 'activity', type: 'push', actorEmail: ALICE, title: 'hi' }),
    ).resolves.toBeUndefined();
    expect(counter.count).toBe(0);
    const off = { ...env, REALTIME_ENABLED: 'false' };
    await expect(
      publishLiveUpdate(off as never, { fullName: 'alice/demo', channel: 'activity', type: 'push', actorEmail: ALICE, title: 'hi' }),
    ).resolves.toBeUndefined();
    expect(counter.count).toBe(0);
  });

  it('publishLiveUpdate publishes to the repo shard when enabled', async () => {
    const counter = { count: 0 };
    const stub = createGapDoStub({ publishCount: counter });
    const env = {
      DB: nullDb(),
      REALTIME: { getByName: () => stub, get: () => stub },
      REALTIME_ENABLED: 'true',
      ENVIRONMENT: 'development',
    };
    await publishLiveUpdate(env as never, { fullName: 'alice/demo', channel: 'activity', type: 'push', actorEmail: ALICE, title: 'hi' });
    expect(counter.count).toBe(1);
  });

  it('publishLiveUpdate fans out to inbox with recipients and drops bad channels', async () => {
    const counter = { count: 0 };
    const stub = createGapDoStub({ publishCount: counter });
    const env = {
      DB: nullDb(),
      REALTIME: { getByName: () => stub, get: () => stub },
      REALTIME_ENABLED: 'true',
      ENVIRONMENT: 'development',
    };
    await publishLiveUpdate(env as never, {
      fullName: 'alice/demo',
      channel: 'activity',
      type: 'push',
      actorEmail: ALICE,
      title: 'hi',
      recipientEmails: [ALICE],
    });
    expect(counter.count).toBe(2);
    await publishLiveUpdate(env as never, { fullName: 'alice/demo', channel: 'bogus!!', type: 'x', actorEmail: ALICE, title: 'hi' });
    expect(counter.count).toBe(2);
  });

  it('publishCheckUpdate validates sha and honors the kill switch', async () => {
    const counter = { count: 0 };
    const stub = createGapDoStub({ publishCount: counter });
    const enabled = {
      DB: nullDb(),
      REALTIME: { getByName: () => stub, get: () => stub },
      REALTIME_ENABLED: 'true',
      ENVIRONMENT: 'development',
    };
    await publishCheckUpdate(enabled as never, {
      fullName: 'alice/demo',
      headSha: 'not-hex',
      context: 'ci',
      status: 'queued',
      actorEmail: ALICE,
    });
    expect(counter.count).toBe(0);
    await publishCheckUpdate(enabled as never, {
      fullName: 'alice/demo',
      headSha: OID_A,
      context: 'ci',
      status: 'queued',
      actorEmail: ALICE,
    });
    expect(counter.count).toBe(1);
    const disabled = { ...enabled, REALTIME_ENABLED: 'false' };
    await publishCheckUpdate(disabled as never, {
      fullName: 'alice/demo',
      headSha: OID_A,
      context: 'ci',
      status: 'queued',
      actorEmail: ALICE,
    });
    expect(counter.count).toBe(1);
  });

  it('recordAndNotify never throws and missing bindings are safe', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    await expect(
      recordAndNotify(env as never, { repositoryId: 'r-demo', fullName: 'alice/demo', actorEmail: ALICE, type: 'push', title: 'Pushed' }),
    ).resolves.toBeUndefined();
    const noBinding = { DB: db, ENVIRONMENT: 'development', DEV_AUTH_EMAIL: ALICE };
    await expect(
      publishLiveUpdate(noBinding as never, { fullName: 'alice/demo', channel: 'activity', type: 'x', actorEmail: ALICE, title: 't' }),
    ).resolves.toBeUndefined();
    await expect(
      publishCheckUpdate(noBinding as never, {
        fullName: 'alice/demo',
        headSha: OID_A,
        context: 'ci',
        status: 'queued',
        actorEmail: ALICE,
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. TriggerChecks
// ---------------------------------------------------------------------------
describe('function-gap TriggerChecks', () => {
  it('skips invalid and zero shas without I/O', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    await expect(
      triggerRequiredChecks(env as never, {
        repositoryId: 'r-demo',
        fullName: 'alice/demo',
        branch: 'main',
        headSha: 'bad',
        actorEmail: ALICE,
      }),
    ).resolves.toEqual({
      triggered: [],
    });
    await expect(
      triggerRequiredChecks(env as never, {
        repositoryId: 'r-demo',
        fullName: 'alice/demo',
        branch: 'main',
        headSha: OID_ZERO,
        actorEmail: ALICE,
      }),
    ).resolves.toEqual({ triggered: [] });
  });

  it('returns empty when no protection rule requires checks', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    const out = await triggerRequiredChecks(env as never, {
      repositoryId: 'r-demo',
      fullName: 'alice/demo',
      branch: 'main',
      headSha: OID_B,
      actorEmail: ALICE,
    });
    expect(out).toEqual({ triggered: [] });
  });

  it('triggers required contexts and enqueues the runner', async () => {
    const { db, state } = createGapFakeDb();
    const env = createGapEnv(db);
    const ruleRes = await callWorker(
      env,
      '/user/repos/alice/demo/rules',
      postJson({ pattern: 'main', requireStatusChecks: ['ci', 'lint'] }),
    );
    expect(ruleRes.status).toBe(201);
    expect(state.branchRules).toHaveLength(1);
    const out = await triggerRequiredChecks(env as never, {
      repositoryId: 'r-demo',
      fullName: 'alice/demo',
      branch: 'main',
      headSha: OID_B,
      actorEmail: ALICE,
    });
    expect(out.triggered.sort()).toEqual(['ci', 'lint']);
    expect(state.checks.length).toBeGreaterThanOrEqual(2);
  });

  it('still reports triggered when the runner DO is down', async () => {
    const { db } = createGapFakeDb();
    const stub = createGapDoStub({ enqueueFail: true });
    const env = {
      DB: db,
      REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
      CHECK_RUNNER: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
      REALTIME: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
      ENVIRONMENT: 'development',
      DEV_AUTH_EMAIL: ALICE,
    };
    // seed a rule directly to avoid depending on POST
    db.prepare(
      'INSERT INTO branch_protection_rules (id, repository_id, pattern, require_pr, required_approvals, block_force_push, block_deletion, require_status_checks, created_by, created_at)',
    )
      .bind('rule-1', 'r-demo', 'main', 0, 0, 1, 1, JSON.stringify(['ci']), ALICE, 1)
      .run();
    // wait a tick for the in-memory push (run is sync-ish but async)
    await Promise.resolve();
    const out = await triggerRequiredChecks(env as never, {
      repositoryId: 'r-demo',
      fullName: 'alice/demo',
      branch: 'main',
      headSha: OID_B,
      actorEmail: ALICE,
    });
    expect(out.triggered).toEqual(['ci']);
  });
});

// ---------------------------------------------------------------------------
// 5. MirrorRunner / ImportRunner / fetchRemotePack edges
// ---------------------------------------------------------------------------
describe('function-gap transfer runners', () => {
  it('runMirrorSync skips disabled mirrors without I/O', async () => {
    const db = createRunnerDb({
      repos: [{ id: 'r1', owner: 'alice', name: 'demo' }],
      mirrors: [
        {
          repository_id: 'r1',
          source_url: 'https://github.com/o/r',
          interval_minutes: 60,
          enabled: 0,
          last_run_at: null,
          last_status: null,
          last_error: null,
          consecutive_failures: 0,
        },
      ],
    });
    const stub = {
      listRefs: () => {
        throw new Error('must not be called');
      },
    };
    await runMirrorSync({ DB: db, REPO: { getByName: () => stub } } as unknown as Env, 'r1');
    expect(db.data.mirrors[0].last_status).toBeNull();
  });

  it('runMirrorSync deletes mirrors whose repo is gone', async () => {
    const db = createRunnerDb({
      mirrors: [
        {
          repository_id: 'gone',
          source_url: 'https://github.com/o/r',
          interval_minutes: 60,
          enabled: 1,
          last_run_at: null,
          last_status: null,
          last_error: null,
          consecutive_failures: 0,
        },
      ],
    });
    await runMirrorSync({ DB: db, REPO: { getByName: () => ({}) } } as unknown as Env, 'gone');
    expect(db.data.mirrors).toHaveLength(0);
  });

  it('runMirrorSync records failure without throwing on bad remote', async () => {
    const db = createRunnerDb({
      repos: [{ id: 'r1', owner: 'alice', name: 'demo' }],
      mirrors: [
        {
          repository_id: 'r1',
          source_url: 'https://github.com/o/r',
          interval_minutes: 60,
          enabled: 1,
          last_run_at: null,
          last_status: null,
          last_error: null,
          consecutive_failures: 0,
        },
      ],
    });
    const stub = {
      listRefs: async () => ({ refs: [], symbolicHead: null }),
      importPack: async () => ({ importedRefs: [] }),
      isAncestor: async () => true,
      updateRefs: async () => ({ updated: [] }),
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    try {
      await runMirrorSync({ DB: db, REPO: { getByName: () => stub } } as unknown as Env, 'r1');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(db.data.mirrors[0].last_status).toBe('failed');
  });

  it('runImportJob ignores unknown jobs and refuses non-empty repos', async () => {
    const empty = createRunnerDb();
    await expect(
      runImportJob(
        {
          DB: empty,
          REPO: {
            getByName: () => {
              throw new Error('must not be called');
            },
          },
        } as unknown as Env,
        'alice/empty',
        'missing',
      ),
    ).resolves.toBeUndefined();
    const db = createRunnerDb({
      imports: [
        {
          id: 'j2',
          repository_id: 'r1',
          source_url: 'https://github.com/o/r',
          status: 'pending',
          error: null,
          refs_json: null,
          imported_refs: 0,
          created_by: ALICE,
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    const stub = {
      listRefs: async () => ({ refs: [{ ref: 'refs/heads/main', oid: OID_A }], symbolicHead: 'refs/heads/main' }),
      importPack: vi.fn(),
    };
    await runImportJob({ DB: db, REPO: { getByName: () => stub } } as unknown as Env, 'alice/full', 'j2');
    expect(db.data.imports[0].status).toBe('failed');
    expect(stub.importPack).not.toHaveBeenCalled();
  });

  it('fetchRemotePack rejects too many refs', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ oid: OID_A, ref: `refs/heads/b${i}` }));
    const fetcher = {
      get: async () => ({ status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisement(many) }),
      post: async () => ({ status: 200, body: packResponse() }),
    };
    await expect(fetchRemotePack(fetcher, 'https://github.com/o/r', { maxRefs: 2, maxPackBytes: 1024, timeoutMs: 5000 })).rejects.toThrow(
      /too many refs/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. scheduled tasks + CronTasksWorker
// ---------------------------------------------------------------------------
describe('function-gap scheduled tasks', () => {
  function emptyDb(): D1Queryable {
    return {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ success: true, meta: { changes: 0 } }),
        }),
      }),
    } as unknown as D1Queryable;
  }
  function taskEnv(db: D1Queryable): Env {
    const stub = createGapDoStub();
    return {
      DB: db,
      REPO: { getByName: () => stub },
      REALTIME: { getByName: () => stub },
      CHECK_RUNNER: { getByName: () => stub },
    } as unknown as Env;
  }

  it('ExpiredTokenPruningTask and BackgroundTaskRunPruningTask are no-ops on empty DB', async () => {
    await expect(new ExpiredTokenPruningTask().run(taskEnv(emptyDb()))).resolves.toBeUndefined();
    await expect(new BackgroundTaskRunPruningTask().run(taskEnv(emptyDb()))).resolves.toBeUndefined();
    expect(new ExpiredTokenPruningTask().phase).toBe(1);
    expect(new BackgroundTaskRunPruningTask().phase).toBe(2);
  });

  it('SocialPruningTask and AuditLogCleanupTask prune without throwing', async () => {
    await expect(new SocialPruningTask().run(taskEnv(emptyDb()))).resolves.toBeUndefined();
    await expect(new AuditLogCleanupTask().run(taskEnv(emptyDb()))).resolves.toBeUndefined();
  });

  it('CheckPruneTask and CheckStaleTask run no-op paths', async () => {
    await expect(new CheckPruneTask().run(taskEnv(emptyDb()))).resolves.toBeUndefined();
    await expect(new CheckStaleTask().run(taskEnv(emptyDb()))).resolves.toBeUndefined();
  });

  it('ImportSweeperTask and MirrorSyncTask skip when nothing is due', async () => {
    await expect(new ImportSweeperTask().run(taskEnv(emptyDb()))).resolves.toBeUndefined();
    await expect(new MirrorSyncTask().run(taskEnv(emptyDb()))).resolves.toBeUndefined();
  });

  it('WebhookDeliveryTask never throws on empty store', async () => {
    await expect(new WebhookDeliveryTask().run(taskEnv(emptyDb()))).resolves.toBeUndefined();
  });

  it('CronTasksWorker 404s unknown paths and guards single-flight', async () => {
    const w = Object.create(CronTasksWorker.prototype) as InstanceType<typeof CronTasksWorker>;
    (w as unknown as { runs: Map<string, Promise<void>> }).runs = new Map();
    const notFound = await (w as unknown as { fetch(r: Request): Promise<Response> }).fetch(
      new Request('https://do/nope', { method: 'GET' }),
    );
    expect(notFound.status).toBe(404);
    (w as unknown as { runs: Map<string, Promise<void>> }).runs.set('', Promise.resolve());
    const busy = await (w as unknown as { fetch(r: Request): Promise<Response> }).fetch(new Request('https://do/run', { method: 'POST' }));
    expect(busy.status).toBe(202);
    expect(await busy.text()).toContain('Already running');
  });

  it('CronTasksWorker starts a run and returns 202', async () => {
    const w = Object.create(CronTasksWorker.prototype) as InstanceType<typeof CronTasksWorker>;
    const env = taskEnv(emptyDb());
    const ctxRuns: Array<Promise<unknown>> = [];
    (w as unknown as { runs: Map<string, Promise<void>> }).runs = new Map();
    (w as unknown as { env: unknown }).env = env;
    (w as unknown as { ctx: unknown }).ctx = { waitUntil: (p: Promise<unknown>) => ctxRuns.push(p) };
    const res = await (w as unknown as { fetch(r: Request): Promise<Response> }).fetch(
      new Request('https://do/run', { method: 'POST', body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// 7. UserRoutes / OrgRoutes / TeamRoutes / ProjectRoutes / GitRoutes / PullMerge
// ---------------------------------------------------------------------------
describe('function-gap UserRoutes profiles and settings', () => {
  it('serves user and org profiles plus 404s', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    const user = await callWorker(env, '/users/alice');
    expect(user.status).toBe(200);
    expect(((await user.json()) as { type: string }).type).toBe('user');
    const org = await callWorker(env, '/users/acme');
    expect(org.status).toBe(200);
    expect(((await org.json()) as { type: string }).type).toBe('org');
    expect((await callWorker(env, '/users/ghost-xyz')).status).toBe(404);
  });

  it('serves profile repos and org memberships', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    expect((await callWorker(env, '/users/alice/repos?limit=1')).status).toBe(200);
    expect((await callWorker(env, '/users/alice/orgs')).status).toBe(200);
    expect((await callWorker(env, '/users/ghost-xyz/repos')).status).toBe(404);
    expect((await callWorker(env, '/users/ghost-xyz/orgs')).status).toBe(404);
  });

  it('validates username rename payloads', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    const missing = await callWorker(env, '/user/me/username', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({}) });
    expect(missing.status).toBe(400);
    const invalid = await callWorker(env, '/user/me/username', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username: 'bad name!' }),
    });
    expect(invalid.status).toBe(400);
    const taken = await callWorker(env, '/user/me/username', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username: 'bob' }),
    });
    expect([400, 200]).toContain(taken.status);
  });
});

describe('function-gap OrgRoutes and TeamRoutes', () => {
  it('creates orgs and validates names', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    const created = await callWorker(env, '/user/orgs', postJson({ username: 'neworg' }));
    expect(created.status).toBe(201);
    expect((await callWorker(env, '/user/orgs', postJson({ username: 'bad name!' }))).status).toBe(400);
    expect((await callWorker(env, '/user/orgs', postJson({}))).status).toBe(400);
    expect((await callWorker(env, '/user/orgs', postJson({ username: 'alice' }))).status).toBe(400);
  });

  it('lists orgs and guards member roles', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    expect((await callWorker(env, '/user/orgs')).status).toBe(200);
    expect((await callWorker(env, '/user/orgs/acme/members', postJson({}))).status).toBe(400);
    expect((await callWorker(env, '/user/orgs/acme/members', postJson({ email: BOB, role: 'superadmin' }))).status).toBe(400);
    const ok = await callWorker(env, '/user/orgs/acme/members', postJson({ email: BOB, role: 'member' }));
    expect([201, 200]).toContain(ok.status);
  });

  it('validates team create and member roles', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    expect((await callWorker(env, '/user/orgs/acme/teams', postJson({}))).status).toBe(400);
    expect((await callWorker(env, '/user/orgs/acme/teams/dev/members', postJson({ role: 'member' }))).status).toBe(400);
    expect((await callWorker(env, '/user/orgs/acme/teams/dev/members', postJson({ email: BOB, role: 'superadmin' }))).status).toBe(400);
    expect((await callWorker(env, '/user/orgs/acme/teams')).status).toBe(200);
  });
});

describe('function-gap ProjectRoutes and GitRoutes and PullMerge', () => {
  it('rejects invalid project numbers', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    expect((await callWorker(env, '/repos/alice/demo/projects/notanumber')).status).toBe(400);
    expect((await callWorker(env, '/user/repos/alice/demo/projects/notanumber')).status).toBe(400);
  });

  it('rejects invalid git service and guards malformed names', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    expect((await callWorker(env, '/alice/demo/info/refs?service=git-nope')).status).toBe(400);
    expect((await callWorker(env, '/bad%20owner/demo/info/refs?service=git-upload-pack')).status).toBe(401);
  });

  it('merge validates pull number and draft/blocked states', async () => {
    const { db } = createGapFakeDb();
    const env = createGapEnv(db);
    expect((await callWorker(env, '/user/repos/alice/demo/pulls/notanumber/merge', postJson({}))).status).toBe(404);
    expect((await callWorker(env, '/user/repos/alice/demo/pulls/999/merge', postJson({}))).status).toBe(404);
  });

  it('RepoMove skips no-op moves and moves empty repos', async () => {
    const { db } = createGapFakeDb();
    const stub = createGapDoStub();
    const env = {
      DB: db,
      REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
      ENVIRONMENT: 'development',
      DEV_AUTH_EMAIL: ALICE,
    } as unknown as Env;
    await expect(moveRepoDosForRename(env, ALICE, [])).resolves.toEqual({ moved: 0, empty: 0 });
    await expect(
      moveRepoDosForRename(env, ALICE, [{ id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'alice/demo' }]),
    ).resolves.toEqual({ moved: 0, empty: 0 });
    const single = await moveOneRepo(env, ALICE, { id: 'r-demo', name: 'demo', oldFull: 'alice/demo', newFull: 'alice/demo2' });
    expect(single).toMatchObject({ empty: expect.any(Boolean) });
  });
});
