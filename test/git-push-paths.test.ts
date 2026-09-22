import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { PktLine } from '@edge-git/git-protocol';
import { TokenService } from '@edge-git/backend-services/auth';
import { triggerRequiredChecks } from '@/workers/routes/TriggerChecks';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import { resetRateLimitForTests } from '@/middleware/rateLimit';

const ALICE = 'alice@example.com';
const PAT = 'slice5-push-pat';
const ZERO = '0'.repeat(40);
const WANT = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function pushPayload(packBytes: Uint8Array): Uint8Array {
  const parts = [PktLine.encode(`${ZERO} ${WANT} refs/heads/main\0report-status\n`), PktLine.encodeFlush(), packBytes];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

interface PushFakeOptions {
  scanMode?: string | null;
  protectionsThrow?: boolean;
  rules?: Array<Record<string, unknown>>;
}

function pushFakeDb(tokenHash: string, opts: PushFakeOptions = {}) {
  const now = 1_800_000_000;
  const repo = {
    id: 'r1',
    owner_email: ALICE,
    owner_user_email: ALICE,
    owner: 'alice',
    name: 'demo',
    description: null,
    is_private: 0,
    created_at: 1,
    updated_at: 1,
    owner_type: 'user',
    owner_ci: 'alice',
    name_ci: 'demo',
    org_id: null,
  };
  const token = {
    token_id: 't1',
    user_email: ALICE,
    token_hash: tokenHash,
    name: 'push',
    expires_at: now + 9999,
    last_used_at: null,
    created_at: 1,
    token_prefix: 'slice5',
  };
  const tokenScopes = [{ scope: 'repo:read' }, { scope: 'repo:write' }];
  return {
    prepare(query: string) {
      const q = query.replace(/\s+/g, ' ').trim();
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>() {
              if (q.includes('FROM repositories WHERE')) return repo as unknown as T;
              if (q.includes('FROM user_access_tokens WHERE token_hash')) return token as unknown as T;
              if (q.includes('FROM repo_security_settings WHERE')) {
                if (opts.scanMode === null) return null;
                return { repository_id: 'r1', secret_scan_mode: opts.scanMode ?? 'warn', updated_by: ALICE, updated_at: 1 } as unknown as T;
              }
              return null;
            },
            async all<T>() {
              if (q.includes('FROM token_repo_grants WHERE')) return { results: [] };
              if (q.includes('SELECT scope FROM token_scopes WHERE')) return { results: tokenScopes as T[] };
              if (q.includes('SELECT context FROM branch_protection_required_checks WHERE')) {
                return { results: contextsForRules(opts.rules ?? []) as T[] };
              }
              if (q.includes('FROM branch_protection_rules WHERE')) {
                if (opts.protectionsThrow) throw new Error('D1 outage');
                return { results: opts.rules ?? [] };
              }
              return { results: [] as T[] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Queryable;
}

// Serve junction rows from legacy JSON-seeded rule fixtures: the DAO reads
// only the junction table, so fakes derive contexts from the seed payload.
function contextsForRules(rules: Array<Record<string, unknown>>): Array<{ context: string }> {
  const out: Array<{ context: string }> = [];
  for (const rule of rules) {
    try {
      const parsed: unknown = JSON.parse(rule.require_status_checks as string);
      if (Array.isArray(parsed)) {
        for (const context of parsed) {
          if (typeof context === 'string' && context.length > 0) out.push({ context });
        }
      }
    } catch {
      // Invalid seed payload → no contexts (fail closed, mirrors the DAO).
    }
  }
  return out;
}

function pushEnv(db: D1Queryable, received: Array<{ protections: unknown }>) {
  const stub = {
    setFullName: async () => undefined,
    listRefs: async () => ({ refs: [], symbolicHead: null }),
    receivePack: async (_body: Uint8Array, protections: unknown) => {
      received.push({ protections });
      return new Response('unpack ok');
    },
    fetch: async () => new Response('PACK'),
  };
  return {
    DB: db,
    REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    ENVIRONMENT: 'development',
  } as unknown as Env;
}

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };

async function push(data: Uint8Array, env: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
  return worker.onRequest(
    new Request('https://git.example.com/alice/demo/git-receive-pack', {
      method: 'POST',
      headers: { authorization: `Bearer ${PAT}`, ...headers },
      body: data as unknown as BodyInit,
    }),
    env,
    CTX,
  );
}

describe('slice5: git-receive-pack secret scan + protections', () => {
  let tokenHash = '';

  beforeEach(async () => {
    resetRateLimitForTests();
    tokenHash = await TokenService.hashToken(PAT);
  });

  it('passes clean pushes to the DO with no protections', async () => {
    const received: Array<{ protections: unknown }> = [];
    const res = await push(pushPayload(new TextEncoder().encode('PACK clean')), pushEnv(pushFakeDb(tokenHash), received));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-EdgeGit-Secret-Warning')).toBe(null);
    expect(received).toHaveLength(1);
    expect(received[0]?.protections).toEqual([]);
  });

  it('warns (header) but delivers on secret findings in warn mode', async () => {
    const received: Array<{ protections: unknown }> = [];
    const body = pushPayload(new TextEncoder().encode('PACK blob AKIAIOSFODNN7EXAMPLE here'));
    const res = await push(body, pushEnv(pushFakeDb(tokenHash), received));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-EdgeGit-Secret-Warning')).toContain('possible secret');
    expect(received).toHaveLength(1);
  });

  it('blocks secret pushes in block mode without touching the DO', async () => {
    const received: Array<{ protections: unknown }> = [];
    const body = pushPayload(new TextEncoder().encode('PACK blob AKIAIOSFODNN7EXAMPLE here'));
    const res = await push(body, pushEnv(pushFakeDb(tokenHash, { scanMode: 'block' }), received));
    expect(received).toHaveLength(0);
    expect([200, 403]).toContain(res.status);
    expect(await res.text()).toContain('secret');
  });

  it('fails closed with 503 when protections cannot load', async () => {
    const received: Array<{ protections: unknown }> = [];
    const res = await push(
      pushPayload(new TextEncoder().encode('PACK clean')),
      pushEnv(pushFakeDb(tokenHash, { protectionsThrow: true }), received),
    );
    expect(res.status).toBe(503);
    expect(received).toHaveLength(0);
  });

  it('rejects unparseable push bodies with 400', async () => {
    const received: Array<{ protections: unknown }> = [];
    const res = await push(new TextEncoder().encode('definitely not a pkt-line stream'), pushEnv(pushFakeDb(tokenHash), received));
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it('rejects oversized packs via Content-Length before reading the body', async () => {
    const received: Array<{ protections: unknown }> = [];
    const res = await push(pushPayload(new TextEncoder().encode('PACK')), pushEnv(pushFakeDb(tokenHash), received), {
      'Content-Length': String(100 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it('advertises receive-pack refs for PAT authed pushers', async () => {
    const received: Array<{ protections: unknown }> = [];
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const res = await worker.onRequest(
      new Request('https://git.example.com/alice/demo/info/refs?service=git-receive-pack', { headers: { authorization: `Bearer ${PAT}` } }),
      pushEnv(pushFakeDb(tokenHash), received),
      CTX,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('git-receive-pack-advertisement');
  });
});

describe('slice5: triggerRequiredChecks', () => {
  function checkFakeDb(rules: Array<Record<string, unknown>> = []) {
    return {
      prepare(query: string) {
        const q = query.replace(/\s+/g, ' ').trim();
        return {
          bind(..._params: unknown[]) {
            return {
              async first() {
                return null;
              },
              async all<T>() {
                if (q.includes('SELECT context FROM branch_protection_required_checks WHERE')) {
                  return { results: contextsForRules(rules) };
                }
                if (q.includes('FROM branch_protection_rules WHERE')) return { results: rules };
                return { results: [] as T[] };
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Queryable;
  }

  const input = { repositoryId: 'r1', fullName: 'alice/demo', branch: 'main', headSha: HEAD, actorEmail: ALICE };

  it('skips invalid and zero shas without touching D1', async () => {
    await expect(triggerRequiredChecks({} as Env, { ...input, headSha: 'zzz' })).resolves.toEqual({ triggered: [] });
    await expect(triggerRequiredChecks({} as Env, { ...input, headSha: ZERO })).resolves.toEqual({ triggered: [] });
  });

  it('returns empty when no rule requires checks', async () => {
    const env = { DB: checkFakeDb(), ENVIRONMENT: 'development' } as unknown as Env;
    await expect(triggerRequiredChecks(env, input)).resolves.toEqual({ triggered: [] });
  });

  it('reports required contexts and enqueues the runner', async () => {
    const enqueued: unknown[] = [];
    const env = {
      DB: checkFakeDb([
        {
          id: 'rule1',
          repository_id: 'r1',
          pattern: '*',
          require_pr: 0,
          required_approvals: 0,
          block_force_push: 0,
          block_deletion: 0,
          require_status_checks: '["ci"]',
          created_by: ALICE,
          created_at: 1,
        },
      ]),
      ENVIRONMENT: 'development',
      CHECK_RUNNER: { getByName: () => ({ enqueueChecks: async (args: unknown) => void enqueued.push(args) }) },
    } as unknown as Env;
    const out = await triggerRequiredChecks(env, input);
    expect(out.triggered).toEqual(['ci']);
    expect(enqueued).toHaveLength(1);
  });

  it('survives a missing CHECK_RUNNER binding (cron sweeps later)', async () => {
    const env = {
      DB: checkFakeDb([
        {
          id: 'rule1',
          repository_id: 'r1',
          pattern: '*',
          require_pr: 0,
          required_approvals: 0,
          block_force_push: 0,
          block_deletion: 0,
          require_status_checks: '["ci"]',
          created_by: ALICE,
          created_at: 1,
        },
      ]),
      ENVIRONMENT: 'development',
    } as unknown as Env;
    await expect(triggerRequiredChecks(env, input)).resolves.toEqual({ triggered: ['ci'] });
  });

  it('never throws when the rule lookup fails', async () => {
    const env = {
      DB: {
        prepare: () => {
          throw new Error('D1 down');
        },
      },
      ENVIRONMENT: 'development',
    } as unknown as Env;
    await expect(triggerRequiredChecks(env, input)).resolves.toEqual({ triggered: [] });
  });
});
