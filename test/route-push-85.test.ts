import { describe, expect, it, vi } from 'vitest';

// `FetchHandler`/`PushHandler` value-import git-service (dofs → cloudflare:*,
// unavailable in node). Stub the barrel: fakes are injected anyway.
vi.mock('@edge-git/git-service', () => {
  class PackLimitError extends Error {}
  return { PackLimitError };
});

import { PktLine } from '@edge-git/git-protocol';
import { FetchHandler } from '@edge-git/background/FetchHandler';
import { PushHandler } from '@edge-git/background/PushHandler';
import { EnvParser } from '@edge-git/backend-runtime/config/EnvParser';
import { EmailAddress, RepoFullName, repoDoKey } from '@edge-git/shared/utils';
import { parseLimit, hasVisibleRepo } from '@/workers/routes/UserRoutes';
import { parseProjectNumber } from '@/workers/routes/ProjectRoutes';
import {
  channelForRepoEvent,
  emitWebhookEvent,
  flushDueWebhookDeliveries,
  publishCheckUpdate,
  publishLiveUpdate,
  recordAndNotify,
} from '@/workers/routes/SocialEmit';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';

function encodeCommand(command: string, args: string[]): Uint8Array {
  const lines = [
    PktLine.encode(`command=${command}\n`),
    PktLine.encodeDelim(),
    ...args.map((a) => PktLine.encode(`${a}\n`)),
    PktLine.encodeFlush(),
  ];
  return PktLine.mergeLines(lines);
}

function pushPayload(cmds: Array<{ oldOid: string; newOid: string; ref: string }>, caps = 'report-status'): Uint8Array {
  const lines = cmds.map((c, i) => PktLine.encode(`${c.oldOid} ${c.newOid} ${c.ref}${i === 0 ? `\0${caps}` : ''}\n`));
  const parts = [...lines, PktLine.encodeFlush(), new TextEncoder().encode('PACK')];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const WANT = 'a'.repeat(40);
const HAVE = 'b'.repeat(40);
const fetchLimits = { maxWants: 64, maxHaves: 512, maxObjects: 10, maxPackBytes: 1024 * 1024, maxFetchBodyBytes: 1024 * 1024 };

function fetchGit(overrides: Record<string, unknown> = {}) {
  return {
    ensureFreshCache: vi.fn(),
    listRefs: vi.fn().mockResolvedValue({ refs: [], symbolicHead: null }),
    readObjectForLsRefs: vi.fn().mockResolvedValue(null),
    findCommonCommits: vi.fn().mockResolvedValue([HAVE]),
    resolveRef: vi.fn().mockImplementation((ref: string) => Promise.resolve(ref)),
    collectObjectsForPack: vi.fn().mockResolvedValue({ oids: [WANT], shallow: [] }),
    packObjects: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    listTags: vi.fn().mockResolvedValue([]),
    peelTag: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as never;
}

describe('slice1: UserRoutes pure helpers', () => {
  it('parseLimit defaults, clamps, and floors', () => {
    expect(parseLimit('https://x/users/alice/repos')).toBe(20);
    expect(parseLimit('https://x/?limit=')).toBe(20);
    expect(parseLimit('https://x/?limit=abc')).toBe(20);
    expect(parseLimit('https://x/?limit=Infinity')).toBe(20);
    expect(parseLimit('https://x/?limit=0')).toBe(1);
    expect(parseLimit('https://x/?limit=-5')).toBe(1);
    expect(parseLimit('https://x/?limit=2.9')).toBe(2);
    expect(parseLimit('https://x/?limit=500')).toBe(100);
    expect(parseLimit('https://x/?limit=7')).toBe(7);
  });

  it('hasVisibleRepo short-circuits and handles empties', async () => {
    const row = { id: 'r1' } as never;
    expect(await hasVisibleRepo([], async () => 'read')).toBe(false);
    expect(await hasVisibleRepo([row], async () => null)).toBe(false);
    const getRole = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('write');
    expect(await hasVisibleRepo([row, row], getRole)).toBe(true);
    expect(getRole).toHaveBeenCalledTimes(2);
  });

  it('hasVisibleRepo propagates DAO failures', async () => {
    await expect(hasVisibleRepo([{ id: 'r1' } as never], async () => Promise.reject(new Error('D1 down')))).rejects.toThrow('D1 down');
  });

  it('parseProjectNumber validates', () => {
    expect(parseProjectNumber(undefined)).toBe(null);
    expect(parseProjectNumber('0')).toBe(null);
    expect(parseProjectNumber('-3')).toBe(null);
    expect(parseProjectNumber('abc')).toBe(null);
    expect(parseProjectNumber('2.5')).toBe(null);
    expect(parseProjectNumber('5')).toBe(5);
  });
});

describe('slice1: SocialEmit channels and never-throw fan-out', () => {
  it('channelForRepoEvent scopes subjects, defaults to activity', () => {
    expect(channelForRepoEvent('issue_opened', 'issue', 12)).toBe('issue:12');
    expect(channelForRepoEvent('pr_merged', 'pull', 34)).toBe('pr:34');
    expect(channelForRepoEvent('push', null, null)).toBe('activity');
    expect(channelForRepoEvent('push', 'issue', null)).toBe('activity');
    expect(channelForRepoEvent('push', 'issue', 1.5)).toBe('activity');
    expect(channelForRepoEvent('push', 'issue', Number.MAX_SAFE_INTEGER + 1)).toBe('activity');
    expect(channelForRepoEvent('push', 'project', 3)).toBe('activity');
  });

  it('publishLiveUpdate no-ops when disabled, bad channel, or missing binding', async () => {
    const base = { fullName: 'alice/demo', channel: 'activity', type: 'push', actorEmail: 'a@x.com', title: 't' };
    await expect(publishLiveUpdate({} as Env, base)).resolves.toBeUndefined();
    await expect(
      publishLiveUpdate({ REALTIME_ENABLED: 'true' } as unknown as Env, { ...base, channel: 'bogus!!' }),
    ).resolves.toBeUndefined();
    await expect(publishLiveUpdate({ REALTIME_ENABLED: 'true' } as unknown as Env, base)).resolves.toBeUndefined();
  });

  it('publishLiveUpdate fans out to repo shard and inbox when enabled', async () => {
    const published: Array<{ shard: string; msg: unknown }> = [];
    const stub = { publish: vi.fn((msg: unknown) => Promise.resolve({ delivered: 1 })) };
    const env = {
      REALTIME_ENABLED: 'true',
      REALTIME: {
        getByName: (shard: string) => ({
          ...stub,
          publish: (m: unknown) => (published.push({ shard, msg: m }), Promise.resolve({ delivered: 1 })),
        }),
      },
    } as unknown as Env;
    await publishLiveUpdate(env, {
      fullName: 'alice/demo',
      channel: 'activity',
      type: 'push',
      actorEmail: 'a@x.com',
      title: 'Pushed',
      recipientEmails: ['b@x.com'],
    });
    expect(published.some((p) => p.shard.startsWith('repo:'))).toBe(true);
    expect(published.some((p) => p.shard === 'inbox:global')).toBe(true);
  });

  it('publishCheckUpdate validates sha and honors the kill switch', async () => {
    const input = { fullName: 'alice/demo', headSha: 'a'.repeat(40), context: 'ci', status: 'completed', actorEmail: 'a@x.com' };
    await expect(publishCheckUpdate({} as Env, input)).resolves.toBeUndefined();
    await expect(publishCheckUpdate({ REALTIME_ENABLED: 'true' } as unknown as Env, { ...input, headSha: 'zzz' })).resolves.toBeUndefined();
    const stub = { publish: vi.fn(() => Promise.resolve({ delivered: 1 })) };
    const env = { REALTIME_ENABLED: 'true', REALTIME: { getByName: () => stub } } as unknown as Env;
    await publishCheckUpdate(env, input);
    expect(stub.publish).toHaveBeenCalledTimes(1);
  });

  it('record/emit/flush never throw without infra', async () => {
    const env = {} as Env;
    await expect(
      recordAndNotify(env, { repositoryId: 'r', fullName: 'a/b', actorEmail: 'a@x.com', type: 'push', title: 'hello @bob' }),
    ).resolves.toBeUndefined();
    await expect(
      emitWebhookEvent(env, { repositoryId: 'r', fullName: 'a/b', actorEmail: 'a@x.com', event: 'push' }),
    ).resolves.toBeUndefined();
    await expect(flushDueWebhookDeliveries(env)).resolves.toEqual({ processed: 0, succeeded: 0, failed: 0 });
  });
});

describe('slice1: EnvParser and Identity edges', () => {
  it('EnvParser coerces numerics and falls back', () => {
    expect(EnvParser.positiveInt({ X: 5 } as unknown as Env, 'X', '10')).toBe(5);
    expect(EnvParser.positiveInt({ X: ' 7 ' } as unknown as Env, 'X', '10')).toBe(7);
    expect(EnvParser.nonNegativeInt({ X: '' } as unknown as Env, 'X', '7')).toBe(0);
    expect(EnvParser.string({ X: 5 } as unknown as Env, 'X', 'b')).toBe(5 as unknown as string);
    expect(EnvParser.boolean({ X: 'TRUE' } as unknown as Env, 'X', 'false')).toBe(false);
  });

  it('EmailAddress and RepoFullName value objects', () => {
    expect(EmailAddress.normalize('  ALICE@Example.COM ')).toBe('alice@example.com');
    expect(EmailAddress.tryParse(null)).toBe(null);
    expect(EmailAddress.tryParse('not-an-email')).toBe(null);
    expect(EmailAddress.parse('a@b.co').prefix()).toBe('a');
    expect(EmailAddress.parse('a@b.co').equals('A@B.CO')).toBe(true);
    expect(RepoFullName.tryParse('a', '.hidden')).toBe(null);
    expect(RepoFullName.tryParse('a', 'x.lock')).toBe(null);
    expect(RepoFullName.tryParse('a', 'a..b')).toBe(null);
    const full = RepoFullName.parse('Foo', 'Bar.git');
    expect(full.toString()).toBe('Foo/Bar');
    expect(full.ownerCi()).toBe('foo');
    expect(full.toStringWithCase()).toBe('Foo/Bar');
    expect(repoDoKey('  FOO  ', '  BAR.GIT  ')).toBe('foo/bar');
  });
});

describe('slice1: FetchHandler uncovered branches', () => {
  it('short-circuits empty wants with noProgress', async () => {
    const git = fetchGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const res = await handler.uploadPack(encodeCommand('fetch', ['done']), fetchLimits);
    expect(res.status).toBe(200);
    expect(git.findCommonCommits).not.toHaveBeenCalled();
  });

  it('rejects unsupported commands', async () => {
    const handler = new FetchHandler({ git: fetchGit(), env: {} as Env, getFullName: () => 'a/b' });
    const res = await handler.uploadPack(encodeCommand('clone', []), fetchLimits);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('unsupported command');
  });

  it('masks generic negotiation failures but passes PackLimitError through', async () => {
    const { PackLimitError } = (await import('@edge-git/git-service')) as unknown as { PackLimitError: new (m: string) => Error };
    const bad = fetchGit({ findCommonCommits: vi.fn().mockRejectedValue(new Error('secret path /tmp/x')) });
    const res = await new FetchHandler({ git: bad, env: {} as Env, getFullName: () => 'a/b' }).uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'done']),
      fetchLimits,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('/tmp/x');
    const limited = fetchGit({ findCommonCommits: vi.fn().mockRejectedValue(new PackLimitError('too many haves')) });
    const res2 = await new FetchHandler({ git: limited, env: {} as Env, getFullName: () => 'a/b' }).uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'done']),
      fetchLimits,
    );
    expect(await res2.text()).toContain('too many haves');
  });

  it('rejects count/oid/filter violations', async () => {
    const handler = new FetchHandler({ git: fetchGit(), env: {} as Env, getFullName: () => 'a/b' });
    const many = Array.from({ length: 65 }, () => `want ${WANT}`).join(' ');
    void many;
    const tooMany = await handler.uploadPack(
      encodeCommand('fetch', [...Array.from({ length: 65 }, () => `want ${WANT}`), 'done']),
      fetchLimits,
    );
    expect(tooMany.status).toBe(400);
    const badOid = await handler.uploadPack(encodeCommand('fetch', ['want not-an-oid', 'done']), fetchLimits);
    expect(badOid.status).toBe(400);
    const badFilter = await handler.uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'done', 'filter blob:limit=99999999999999999999']),
      fetchLimits,
    );
    expect(badFilter.status).toBe(400);
  });

  it('rejects deepen-not floods at count validation before resolveRef fan-out', async () => {
    const git = fetchGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const res = await handler.uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'done', 'deepen-not refs/heads/a', 'deepen-not refs/heads/b', 'deepen-not refs/heads/c']),
      { ...fetchLimits, maxHaves: 2 },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('too many deepen-not');
    expect(git.resolveRef).not.toHaveBeenCalled();
  });

  it('expands include-tag and enforces the tag-bomb pre-check', async () => {
    const tagOid = 'c'.repeat(40);
    const git = fetchGit({
      listTags: vi.fn().mockResolvedValue([{ oid: tagOid }]),
      peelTag: vi.fn().mockResolvedValue(WANT),
    });
    const res = await new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' }).uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'done', 'include-tag']),
      fetchLimits,
    );
    expect(res.status).toBe(200);
    expect(git.packObjects).toHaveBeenCalledWith(expect.arrayContaining([WANT, tagOid]));
    const bomb = fetchGit({
      collectObjectsForPack: vi
        .fn()
        .mockResolvedValue({ oids: Array.from({ length: 11 }, (_, i) => `${i}`.padStart(40, '0')), shallow: [] }),
    });
    const res2 = await new FetchHandler({ git: bomb, env: {} as Env, getFullName: () => 'a/b' }).uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'done']),
      fetchLimits,
    );
    expect(res2.status).toBe(413);
  });

  it('rejects oversized packs and masks packObjects crashes', async () => {
    const big = fetchGit({ packObjects: vi.fn().mockResolvedValue(new Uint8Array(100)) });
    const res = await new FetchHandler({ git: big, env: {} as Env, getFullName: () => 'a/b' }).uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'done']),
      { ...fetchLimits, maxPackBytes: 10 },
    );
    expect(res.status).toBe(413);
    const boom = fetchGit({ packObjects: vi.fn().mockRejectedValue(new Error('disk on fire')) });
    const res2 = await new FetchHandler({ git: boom, env: {} as Env, getFullName: () => 'a/b' }).uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'done']),
      fetchLimits,
    );
    expect(res2.status).toBe(500);
  });

  it('survives tag-listing failures and wait-for-done negotiation', async () => {
    const git = fetchGit({ listTags: vi.fn().mockRejectedValue(new Error('nope')) });
    const res = await new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' }).uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'done', 'include-tag']),
      fetchLimits,
    );
    expect(res.status).toBe(200);
    const waiting = await new FetchHandler({ git: fetchGit(), env: {} as Env, getFullName: () => 'a/b' }).uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'wait-for-done']),
      fetchLimits,
    );
    expect(waiting.status).toBe(200);
  });

  it('tracks shallow boundaries and unshallows fulfilled lines', async () => {
    const git = fetchGit({ collectObjectsForPack: vi.fn().mockResolvedValue({ oids: [WANT], shallow: ['d'.repeat(40)] }) });
    const res = await new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' }).uploadPack(
      encodeCommand('fetch', [`want ${WANT}`, 'done', 'deepen 5', `shallow ${'e'.repeat(40)}`]),
      fetchLimits,
    );
    expect(res.status).toBe(200);
  });
});

describe('slice1: PushHandler uncovered branches', () => {
  function handler(git: ReturnType<typeof pushGit>, fs?: ReturnType<typeof pushFs>) {
    return new PushHandler({
      isoGitFs: fs ?? pushFs(),
      git: git as never,
      getFullName: () => 'a/b',
    });
  }

  function pushGit(overrides: Record<string, unknown> = {}) {
    return {
      indexPack: vi.fn().mockResolvedValue(undefined),
      isAncestor: vi.fn().mockResolvedValue(true),
      applyRefUpdates: vi.fn().mockResolvedValue([{ ref: 'refs/heads/main', ok: true }]),
      clearCache: vi.fn(),
      ...overrides,
    };
  }

  function pushFs() {
    return { promises: { writeFile: vi.fn().mockResolvedValue(undefined), unlink: vi.fn().mockResolvedValue(undefined) } } as never;
  }

  const create = { oldOid: '0'.repeat(40), newOid: WANT, ref: 'refs/heads/main' };

  it('rejects oversized packs before parsing', async () => {
    const res = await handler(pushGit()).receivePack(new Uint8Array(11), { maxCommands: 100, maxPackBytes: 10 }, []);
    expect(await res.text()).toContain('pack too large');
  });

  it('enforces command-count limits', async () => {
    const data = pushPayload([create, { ...create, ref: 'refs/heads/other' }]);
    const res = await handler(pushGit()).receivePack(data, { maxCommands: 1, maxPackBytes: 100000 }, []);
    expect(await res.text()).toContain('too many');
  });

  it('rejects malformed commands', async () => {
    const data = pushPayload([{ oldOid: WANT, newOid: HAVE, ref: 'refs/heads/a..b' }]);
    const res = await handler(pushGit()).receivePack(data, { maxCommands: 100, maxPackBytes: 100000 }, []);
    expect(await res.text()).toContain('invalid ref name');
  });

  it('logs and ignores push-options', async () => {
    const data = pushPayload([create], 'report-status push-options');
    const git = pushGit();
    const res = await handler(git).receivePack(data, { maxCommands: 100, maxPackBytes: 100000 }, []);
    expect(res.status).toBe(200);
    expect(git.applyRefUpdates).toHaveBeenCalled();
  });

  it('blocks protected deletions pre-receive style', async () => {
    const del = { oldOid: WANT, newOid: '0'.repeat(40), ref: 'refs/heads/main' };
    const git = pushGit();
    const res = await handler(git).receivePack(pushPayload([del]), { maxCommands: 100, maxPackBytes: 100000 }, [
      { ref: 'refs/heads/main', blockDeletion: true } as never,
    ]);
    expect(await res.text()).toContain('deletion');
    expect(git.applyRefUpdates).not.toHaveBeenCalled();
  });

  it('blocks non-fast-forward force pushes after indexing', async () => {
    const git = pushGit({ isAncestor: vi.fn().mockResolvedValue(false) });
    const update = { oldOid: HAVE, newOid: WANT, ref: 'refs/heads/main' };
    const res = await handler(git).receivePack(pushPayload([update]), { maxCommands: 100, maxPackBytes: 100000 }, [
      { ref: 'refs/heads/main', blockForcePush: true } as never,
    ]);
    expect(await res.text()).toContain('non-fast-forward');
    expect(git.applyRefUpdates).not.toHaveBeenCalled();
  });

  it('fails closed on transient ancestry errors', async () => {
    const git = pushGit({ isAncestor: vi.fn().mockRejectedValue(new Error('D1 flake')) });
    const update = { oldOid: HAVE, newOid: WANT, ref: 'refs/heads/main' };
    const res = await handler(git).receivePack(pushPayload([update]), { maxCommands: 100, maxPackBytes: 100000 }, [
      { ref: 'refs/heads/main', blockForcePush: true } as never,
    ]);
    expect(await res.text()).toContain('transient ancestry');
    expect(git.applyRefUpdates).not.toHaveBeenCalled();
  });
});

describe('PushHandler first-push default branch', () => {
  function handler(git: Record<string, unknown>) {
    return new PushHandler({
      isoGitFs: { promises: { writeFile: vi.fn().mockResolvedValue(undefined), unlink: vi.fn().mockResolvedValue(undefined) } } as never,
      git: git as never,
      getFullName: () => 'a/b',
    });
  }

  function firstPushGit(headOid: string | null) {
    return {
      indexPack: vi.fn().mockResolvedValue(undefined),
      isAncestor: vi.fn().mockResolvedValue(true),
      applyRefUpdates: vi.fn().mockResolvedValue([{ ref: 'refs/heads/master', ok: true }]),
      resolveRef: vi.fn().mockResolvedValue(headOid),
      setDefaultBranch: vi.fn().mockResolvedValue({ ok: true, defaultBranch: 'master' }),
      clearCache: vi.fn(),
    };
  }

  it('points HEAD at the first created branch while HEAD dangles', async () => {
    const git = firstPushGit(null);
    const create = { oldOid: '0'.repeat(40), newOid: WANT, ref: 'refs/heads/master' };
    const res = await handler(git).receivePack(pushPayload([create]), { maxCommands: 100, maxPackBytes: 100000 }, []);
    expect(res.status).toBe(200);
    expect(git.setDefaultBranch).toHaveBeenCalledWith('master');
  });

  it('leaves HEAD alone when it already resolves', async () => {
    const git = firstPushGit(WANT);
    const create = { oldOid: '0'.repeat(40), newOid: WANT, ref: 'refs/heads/feature' };
    const res = await handler(git).receivePack(pushPayload([create]), { maxCommands: 100, maxPackBytes: 100000 }, []);
    expect(res.status).toBe(200);
    expect(git.setDefaultBranch).not.toHaveBeenCalled();
  });
});

describe('slice1: GitRoutes early rejects (no D1)', () => {
  const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };

  async function call(path: string): Promise<Response> {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    return worker.onRequest(new Request(`https://git.example.com${path}`), {} as Env, CTX);
  }

  it('rejects malformed owner/name with 401 before sharding', async () => {
    const res = await call('/Bad!Name/demo/info/refs?service=git-upload-pack');
    expect(res.status).toBe(401);
  });

  it('rejects unknown service with 400', async () => {
    const res = await call('/alice/demo/info/refs?service=git-fake-pack');
    expect(res.status).toBe(400);
  });
});
