import { describe, expect, it } from 'vitest';
import {
  PktLine,
  buildUploadPackRequest,
  decodeUploadPackResponse,
  normalizePublicGitUrl,
  parseUploadPackAdvertisement,
} from '@edge-git/git-protocol';
import { scanBytes, scanText } from '@edge-git/backend-services/security';
import { SecuritySettingsService } from '@edge-git/backend-services/security';
import { DeployKeyService } from '@edge-git/backend-services/deploykey';
import { ImportService } from '@edge-git/backend-services/transfer/ImportService';
import { MirrorService } from '@edge-git/backend-services/transfer/MirrorService';
import { TokenService } from '@edge-git/backend-services/auth';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function advertisementBytes(): Uint8Array {
  const lines = [
    PktLine.encode('# service=git-upload-pack\n'),
    PktLine.encodeFlush(),
    PktLine.encode(
      `${OID_A} refs/heads/main\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-not filter object-format=sha1\n`,
    ),
    PktLine.encode(`${OID_B} refs/tags/v1.0.0^{}\n`),
    PktLine.encode(`${'c'.repeat(40)} refs/pull/1/head\n`),
    PktLine.encodeFlush(),
  ];
  return PktLine.mergeLines(lines);
}

describe('normalizePublicGitUrl', () => {
  it('accepts public https URLs and strips query/fragment', () => {
    expect(normalizePublicGitUrl('https://github.com/owner/repo')).toBe('https://github.com/owner/repo');
    expect(normalizePublicGitUrl('https://github.com/owner/repo.git?x=1#frag')).toBe('https://github.com/owner/repo.git');
  });

  it('rejects non-https, credentials, private hosts, and empty input', () => {
    for (const bad of [
      '',
      'not-a-url',
      'http://github.com/owner/repo',
      'https://user:pass@github.com/owner/repo',
      'https://localhost/owner/repo',
      'https://127.0.0.1/owner/repo',
      'https://10.0.0.5/owner/repo',
      'https://192.168.1.1/owner/repo',
      'https://169.254.169.254/latest',
      'https://github.com',
    ]) {
      expect(() => normalizePublicGitUrl(bad), bad).toThrow();
    }
  });
});

describe('parseUploadPackAdvertisement', () => {
  it('extracts heads and tags, skips service header and non-branch refs', () => {
    const refs = parseUploadPackAdvertisement(advertisementBytes(), 100);
    expect(refs).toEqual([
      { ref: 'refs/heads/main', oid: OID_A },
      { ref: 'refs/tags/v1.0.0^{}', oid: OID_B },
    ]);
  });

  it('enforces the ref cap', () => {
    expect(() => parseUploadPackAdvertisement(advertisementBytes(), 1)).toThrow();
  });
});

describe('buildUploadPackRequest', () => {
  it('emits want lines, flush, and done', () => {
    const body = buildUploadPackRequest([OID_A, OID_B]);
    const text = PktLine.decodeText(body);
    expect(text).toContain(`want ${OID_A}`);
    expect(text).toContain(`want ${OID_B}`);
    expect(text).toContain('done\n');
    expect(text).toContain('side-band-64k');
  });

  it('rejects empty wants and malformed oids', () => {
    expect(() => buildUploadPackRequest([])).toThrow();
    expect(() => buildUploadPackRequest(['nope'])).toThrow();
  });
});

describe('decodeUploadPackResponse', () => {
  it('concatenates pack band chunks and skips progress/NAK', () => {
    const pack = new Uint8Array([...new TextEncoder().encode('PACK'), 0, 0, 0, 2, 0, 0, 0, 0]);
    const body = PktLine.mergeLines([
      PktLine.encode('NAK\n'),
      PktLine.encodeSideband(2, new TextEncoder().encode('Counting objects: 3\r')),
      PktLine.encodeSideband(1, pack.slice(0, 5)),
      PktLine.encodeSideband(1, pack.slice(5)),
      PktLine.encodeFlush(),
    ]);
    expect(decodeUploadPackResponse(body, 1024).pack).toEqual(pack);
  });

  it('throws on remote errors, non-pack payloads, and over-limit packs', () => {
    const errBody = PktLine.mergeLines([PktLine.encodeSideband(3, new TextEncoder().encode('not our ref'))]);
    expect(() => decodeUploadPackResponse(errBody, 1024)).toThrow(/remote error/);
    const junk = PktLine.mergeLines([PktLine.encodeSideband(1, new TextEncoder().encode('hello'))]);
    expect(() => decodeUploadPackResponse(junk, 1024)).toThrow(/packfile/);
    const big = new Uint8Array([...new TextEncoder().encode('PACK'), 1, 2, 3]);
    const bigBody = PktLine.mergeLines([PktLine.encodeSideband(1, big)]);
    expect(() => decodeUploadPackResponse(bigBody, 4)).toThrow(/too large/);
  });
});

describe('secret scanning', () => {
  it('flags known secret shapes and passes clean text', () => {
    expect(scanText('nothing to see here').length).toBe(0);
    expect(scanText('key = AKIAIOSFODNN7EXAMPLE').map((f) => f.ruleId)).toContain('aws-access-key');
    expect(scanText('token ghp_123456789012345678901234567890123456 here').map((f) => f.ruleId)).toContain('github-token');
    expect(scanText('xoxb-123456789012-abcdefghij here').map((f) => f.ruleId)).toContain('slack-token');
    expect(scanText('sk_live_abcdefghijklmnop here').map((f) => f.ruleId)).toContain('stripe-key');
    expect(scanText('-----BEGIN RSA PRIVATE KEY-----').map((f) => f.ruleId)).toContain('private-key');
    expect(scanText('glpat-abcdefghijklmnopqrst here').map((f) => f.ruleId)).toContain('gitlab-token');
  });

  it('scans binary pack bytes without throwing', () => {
    const body = new Uint8Array([0, 1, 2, ...new TextEncoder().encode('AKIAIOSFODNN7EXAMPLE'), 255]);
    expect(scanBytes(body).map((f) => f.ruleId)).toContain('aws-access-key');
    expect(scanBytes(new Uint8Array([])).length).toBe(0);
  });
});

describe('SecuritySettingsService', () => {
  it('defaults to warn and round-trips mode changes', async () => {
    const rows = new Map<string, { secret_scan_mode: 'off' | 'warn' | 'block' }>();
    const fakeDAO = {
      getByRepo: async (id: string) =>
        rows.has(id) ? { repository_id: id, secret_scan_mode: rows.get(id)?.secret_scan_mode, updated_by: null, updated_at: 0 } : null,
      setScanMode: async (id: string, mode: 'off' | 'warn' | 'block') => {
        rows.set(id, { secret_scan_mode: mode });
      },
    };
    const svc = new SecuritySettingsService({ DB: {} as never }, { settingsDAO: async () => fakeDAO as never });
    await expect(svc.getMode('missing')).resolves.toBe('warn');
    await svc.setMode('r1', 'block', 'Admin@Example.com');
    await expect(svc.getMode('r1')).resolves.toBe('block');
    expect(() => SecuritySettingsService.normalizeMode('nope')).toThrow();
  });
});

describe('DeployKeyService', () => {
  function fakeDeployDAO() {
    const rows: Array<Record<string, unknown>> = [];
    return {
      rows,
      countByRepo: async () => rows.length,
      create: async (input: Record<string, unknown>) => {
        rows.push({ ...input, token_hash: input.tokenHash, repository_id: input.repositoryId });
      },
      listByRepo: async () =>
        rows.map((r) => ({
          id: r.id,
          repository_id: r.repositoryId,
          name: r.name,
          token_hash: r.tokenHash,
          token_prefix: r.tokenPrefix,
          permission: r.permission,
          expires_at: r.expiresAt,
          last_used_at: null,
          created_by: 'a@b.c',
          created_at: 0,
        })),
      getByIdAndRepo: async (id: string) => rows.find((r) => r.id === id) ?? null,
      deleteByIdAndRepo: async (id: string) => {
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
      },
      getByTokenHash: async (hash: string) => {
        const found = rows.find((r) => r.tokenHash === hash);
        return found ? { repository_id: found.repositoryId, token_hash: hash, permission: found.permission } : null;
      },
      updateLastUsedByHash: async () => undefined,
    };
  }

  it('mints one-time keys with distinct hash domain and authenticates per repo', async () => {
    const dao = fakeDeployDAO();
    const svc = new DeployKeyService({ DB: {} as never }, { deployKeyDAO: async () => dao as never });
    const created = await svc.createKey('repo-1', 'ci', 'read', 'admin@example.com');
    expect(created.key.length).toBeGreaterThan(20);
    expect(created.prefix).toBe(created.key.slice(0, 12));
    // PAT domain must not collide with deploy-key domain.
    const patHash = await (await import('@edge-git/backend-services/auth')).TokenService.hashToken(created.key);
    const deployHash = await DeployKeyService.hashKey(created.key);
    expect(patHash).not.toBe(deployHash);
    const auth = await svc.authenticateWithKey(created.key);
    expect(auth).toEqual({ repositoryId: 'repo-1', permission: 'read' });
    await expect(svc.authenticateWithKey('bogus')).resolves.toBeNull();
    expect(DeployKeyService.normalizePermission(undefined)).toBe('read');
    expect(() => DeployKeyService.normalizePermission('owner')).toThrow();
  });
});

describe('ImportService jobs', () => {
  function fakeImportDAO() {
    const rows: Array<Record<string, unknown>> = [];
    return {
      rows,
      create: async (input: Record<string, unknown>) => {
        rows.push({
          id: input.id,
          repository_id: input.repositoryId,
          source_url: input.sourceUrl,
          status: 'pending',
          error: null,
          refs_json: null,
          imported_refs: 0,
          created_by: input.createdBy,
          created_at: 0,
          updated_at: 0,
        });
      },
      getById: async (id: string) => rows.find((r) => r.id === id) ?? null,
      hasActiveForRepo: async (repo: string) =>
        rows.some((r) => r.repository_id === repo && (r.status === 'pending' || r.status === 'running')),
      markCancelled: async (id: string) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.status = 'cancelled';
      },
    };
  }

  it('normalizes URLs, blocks concurrent jobs, and cancels', async () => {
    const dao = fakeImportDAO();
    const svc = new ImportService({ DB: {} as never }, { importDAO: async () => dao as never });
    const job = await svc.createJob('repo-1', 'https://github.com/o/r?x=1', 'Admin@Example.com');
    expect(job.sourceUrl).toBe('https://github.com/o/r');
    expect(job.status).toBe('pending');
    await expect(svc.createJob('repo-1', 'https://github.com/o/other', 'a@b.c')).rejects.toThrow(/already in progress/);
    await expect(svc.createJob('repo-1', 'http://evil.local/x', 'a@b.c')).rejects.toThrow();
    const cancelled = await svc.cancelJob(job.id);
    expect(cancelled.status).toBe('cancelled');
    const limits = svc.transferLimits();
    expect(limits.maxRefs).toBeGreaterThan(0);
    expect(limits.maxPackBytes).toBeGreaterThan(0);
  });
});

describe('MirrorService config', () => {
  function fakeMirrorDAO() {
    let row: Record<string, unknown> | null = null;
    return {
      upsert: async (input: Record<string, unknown>) => {
        row = {
          repository_id: input.repositoryId,
          source_url: input.sourceUrl,
          interval_minutes: input.intervalMinutes,
          enabled: 1,
          last_run_at: null,
          last_status: null,
          last_error: null,
          consecutive_failures: 0,
          created_by: input.createdBy,
          created_at: 0,
          updated_at: 0,
        };
      },
      getByRepo: async () => row,
      setEnabled: async (_id: string, enabled: boolean) => {
        if (row) row.enabled = enabled ? 1 : 0;
      },
      deleteByRepo: async () => {
        row = null;
      },
    };
  }

  it('validates intervals and normalizes source URLs', async () => {
    const dao = fakeMirrorDAO();
    const svc = new MirrorService({ DB: {} as never }, { mirrorDAO: async () => dao as never });
    const mirror = await svc.configure('repo-1', 'https://github.com/o/r.git', 60, 'a@b.c');
    expect(mirror.sourceUrl).toBe('https://github.com/o/r.git');
    expect(mirror.intervalMinutes).toBe(60);
    await expect(svc.configure('repo-1', 'https://github.com/o/r', 61, 'a@b.c')).rejects.toThrow(/intervalMinutes/);
    await expect(svc.configure('repo-1', 'https://10.1.2.3/r', 60, 'a@b.c')).rejects.toThrow();
    const disabled = await svc.setEnabled('repo-1', false);
    expect(disabled.enabled).toBe(false);
    expect(MirrorService.allowedIntervals()).toContain(1440);
  });
});

describe('TokenService repo grants and rotation', () => {
  function fakes() {
    const tokens: Array<Record<string, unknown>> = [];
    const grants: Array<{ token_id: string; repository_id: string; scope: 'repo:read' | 'repo:write' | 'admin' }> = [];
    const repos = new Map<string, { id: string; owner: string; name: string }>([['r1', { id: 'r1', owner: 'alice', name: 'demo' }]]);
    const tokenDAO = {
      getByTokenHash: async (hash: string, now: number) => {
        const t = tokens.find((row) => row.token_hash === hash && (row.expires_at as number) > now);
        if (!t) return undefined;
        return {
          tokenId: t.token_id,
          userEmail: t.user_email,
          tokenHash: t.token_hash,
          name: t.name,
          expiresAt: t.expires_at,
          lastUsedAt: null,
          createdAt: t.created_at,
          scopes: JSON.parse(String(t.scopes ?? '["repo:read","repo:write","admin"]')),
          tokenPrefix: (t.token_prefix as string | null) ?? null,
        };
      },
      getByUserEmail: async (email: string) =>
        tokens
          .filter((t) => String(t.user_email).toLowerCase() === email.toLowerCase())
          .map((t) => ({
            tokenId: t.token_id,
            userEmail: t.user_email,
            tokenHash: t.token_hash,
            name: t.name,
            expiresAt: t.expires_at,
            lastUsedAt: null,
            createdAt: t.created_at,
            scopes: JSON.parse(String(t.scopes ?? '["repo:read","repo:write","admin"]')),
            tokenPrefix: t.token_prefix ?? null,
          })),
      updateLastUsedByHash: async () => undefined,
      create: async (
        tokenId: string,
        userEmail: string,
        tokenHash: string,
        name: string,
        expiresAt: number,
        now: number,
        scopes?: readonly string[],
        prefix?: string | null,
      ) => {
        tokens.push({
          token_id: tokenId,
          user_email: userEmail,
          token_hash: tokenHash,
          name,
          expires_at: expiresAt,
          created_at: now,
          scopes: JSON.stringify(scopes ?? []),
          token_prefix: prefix ?? null,
        });
      },
      delete: async (tokenId: string) => {
        const i = tokens.findIndex((t) => t.token_id === tokenId);
        if (i >= 0) tokens.splice(i, 1);
      },
      rotate: async (tokenId: string, _email: string, newHash: string, newPrefix: string, newExpires: number) => {
        const row = tokens.find((t) => t.token_id === tokenId);
        if (!row) return false;
        row.token_hash = newHash;
        row.token_prefix = newPrefix;
        row.expires_at = newExpires;
        return true;
      },
    };
    const repositoryDAO = {
      getByOwnerAndName: async (owner: string, name: string) => {
        const clean = name.endsWith('.git') ? name.slice(0, -4) : name;
        for (const repo of repos.values()) {
          if (repo.owner.toLowerCase() === owner.toLowerCase() && repo.name.toLowerCase() === clean.toLowerCase())
            return { ...repo, owner_email: 'a@b.c', description: null, is_private: 0, created_at: 0, updated_at: 0 };
        }
        return null;
      },
      getById: async (id: string) => {
        const repo = repos.get(id);
        return repo ? { ...repo, owner_email: 'a@b.c', description: null, is_private: 0, created_at: 0, updated_at: 0 } : null;
      },
    };
    const tokenGrantDAO = {
      listByToken: async (tokenId: string) => grants.filter((g) => g.token_id === tokenId),
      setGrants: async (tokenId: string, next: Array<{ repositoryId: string; scope: 'repo:read' | 'repo:write' | 'admin' }>) => {
        for (let i = grants.length - 1; i >= 0; i -= 1) if (grants[i].token_id === tokenId) grants.splice(i, 1);
        for (const g of next) grants.push({ token_id: tokenId, repository_id: g.repositoryId, scope: g.scope });
      },
      deleteByToken: async (tokenId: string) => {
        for (let i = grants.length - 1; i >= 0; i -= 1) if (grants[i].token_id === tokenId) grants.splice(i, 1);
      },
    };
    return { tokenDAO, repositoryDAO, tokenGrantDAO, tokens };
  }

  it('scopes tokens to repos, authenticates grants, and rotates secrets', async () => {
    const { tokenDAO, repositoryDAO, tokenGrantDAO, tokens } = fakes();
    const svc = new TokenService(
      { DB: {} as never },
      {
        tokenDAO: async () => tokenDAO as never,
        repositoryDAO: async () => repositoryDAO as never,
        tokenGrantDAO: async () => tokenGrantDAO as never,
      },
    );
    const created = await svc.createToken(
      'alice@example.com',
      'scoped',
      30,
      ['repo:read', 'repo:write', 'admin'],
      [{ owner: 'alice', name: 'demo', scope: 'repo:read' }],
    );
    expect(created.prefix).toBe(created.token.slice(0, 12));
    const authed = await svc.authenticateWithPAT(created.token);
    expect(authed.repoGrants).toEqual([{ repositoryId: 'r1', scope: 'repo:read' }]);
    const listed = await svc.listTokens('alice@example.com');
    expect(listed[0].tokenPrefix).toBe(created.prefix);
    expect(listed[0].repoGrants?.[0].fullName).toBe('alice/demo');
    const rotated = await svc.rotateToken(created.tokenId, 'alice@example.com');
    expect(rotated.token).not.toBe(created.token);
    await expect(svc.authenticateWithPAT(created.token)).rejects.toThrow();
    const reauthed = await svc.authenticateWithPAT(rotated.token);
    expect(reauthed.repoGrants).toEqual([{ repositoryId: 'r1', scope: 'repo:read' }]);
    expect(tokens.length).toBe(1);
    await expect(
      svc.createToken('alice@example.com', 'bad', 30, undefined, [{ owner: 'nobody', name: 'missing', scope: 'repo:read' }]),
    ).rejects.toThrow(/not found/);
  });
});
