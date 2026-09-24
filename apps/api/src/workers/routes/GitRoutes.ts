import { getScope } from './PublicViewerResolver';
import type { Hono } from 'hono';
import { gitAuthForRepo } from '@/middleware';
import { clientIp } from '@/middleware/rateLimit';
import { getRepoStub } from '../doStubs';
import { RepoFullName } from '@edge-git/shared/utils';
import {
  advertiseUploadPack,
  advertiseReceivePack,
  branchNameFromRef,
  buildReportStatus,
  parseReceivePackRequest,
} from '@edge-git/git-protocol';
import type { ProtectedRefRule } from '@edge-git/git-protocol';
import type { BranchProtectionRuleMetadata } from '@edge-git/shared';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { BranchProtectionService } from '@edge-git/backend-services/protection';
import { scanBytes } from '@edge-git/backend-services/security';
import { recordAndNotify } from './SocialEmit';
import { parseContentLength } from './RouteInput';
import { triggerRequiredChecks } from './TriggerChecks';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import {
  checkFetchLoop,
  etagForRefs,
  getCachedPack,
  getCachedRefs,
  hashFetchBody,
  headOidFromRefs,
  invalidateRepoCaches,
  putCachedPack,
  putCachedRefs,
  withEtagHeaders,
} from './RepoReadCache';

type GitApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

// Git Smart HTTP — must stay outside Access auth (PAT/anonymous).
function registerGitRoutes(app: GitApp): void {
  app.get('/:owner/:repo/info/refs', async (c) => {
    const owner = c.req.param('owner');
    const repoParam = c.req.param('repo');
    const repoName = RepoFullName.normalizeRepo(repoParam);
    // Reject malformed owner/name before D1/DO sharding (weird names must
    // never reach `REPO.getByName`). 401 (not 404/400) preserves the
    // private-repo existence oracle guard.
    if (!RepoFullName.tryParse(owner, repoName)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Edge-Git"' },
      });
    }
    const service = new URL(c.req.url).searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return c.text('Invalid service', 400);
    }
    const auth = await gitAuthForRepo(c, owner, repoName, service);
    if (auth instanceof Response) return auth;
    if (service === 'git-upload-pack') {
      return advertiseUploadPack();
    }
    const fullName = `${owner}/${repoName}`;
    const cache = getScope(c).get(Tokens.KvCache);
    const cached = await getCachedRefs(cache, fullName);
    if (cached) {
      const res = await advertiseReceivePack(() => Promise.resolve(cached));
      const etag = etagForRefs(cached);
      if (etag) return withEtagHeaders(res, etag, 'private, max-age=30, must-revalidate');
      return res;
    }
    const stub = getRepoStub(c.env, fullName);
    const snapshot = await stub.listRefs();
    await putCachedRefs(cache, fullName, snapshot);
    const res = await advertiseReceivePack(() => Promise.resolve(snapshot));
    const etag = etagForRefs(snapshot);
    if (etag) return withEtagHeaders(res, etag, 'private, max-age=30, must-revalidate');
    return res;
  });

  app.post('/:owner/:repo/git-upload-pack', async (c) => {
    const owner = c.req.param('owner');
    const repoParam = c.req.param('repo');
    const repoName = RepoFullName.normalizeRepo(repoParam);
    if (!RepoFullName.tryParse(owner, repoName)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Edge-Git"' },
      });
    }
    const auth = await gitAuthForRepo(c, owner, repoName, 'git-upload-pack');
    if (auth instanceof Response) return auth;
    const maxFetchBodyBytes = ConfigurationManager.repo.getMaxFetchBodyBytes(c.env);
    // Fail-closed header gate + authoritative body check below: a missing or
    // malformed Content-Length skips the cheap early 413 and falls through to
    // the exact `body.byteLength` enforcement, so NaN can never bypass limits.
    const contentLength = parseContentLength(c.req.header('Content-Length'));
    if (contentLength !== null && contentLength > maxFetchBodyBytes) {
      return c.text(`ERR fetch request too large: ${contentLength} > ${maxFetchBodyBytes} bytes`, 413);
    }
    const fullName = `${owner}/${repoName}`;
    const stub = getRepoStub(c.env, fullName);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > maxFetchBodyBytes) {
      return c.text(`ERR fetch request too large: ${body.byteLength} > ${maxFetchBodyBytes} bytes`, 413);
    }
    // Fetch-loop guard: identical bodies from the same caller inside 5min are
    // cheap 429s instead of repeated pack walks (each burns thousands of DO
    // rows). Fail-open on KV errors so caching can never break fetches.
    try {
      const cache = getScope(c).get(Tokens.KvCache);
      const identity = auth.userEmail ?? `ip:${clientIp(c)}`;
      const guard = await checkFetchLoop(cache, fullName, identity, body);
      if (!guard.allowed) {
        return c.text('Rate limit exceeded; try again later.', 429, { 'Retry-After': String(guard.retryAfter) });
      }
    } catch {
      // Fail open — fetch proceeds to the DO on cache errors.
    }
    // Small-response pack cache: identical polls between pushes skip the DO
    // pack walk entirely. Keyed by (headOid, bodyHash); pushes purge the
    // `readmodel` prefix so a new head always misses. `listRefs` warms the
    // 24h refs snapshot as a side effect (one cheap DO call on first miss).
    try {
      const cache = getScope(c).get(Tokens.KvCache);
      let snapshot = await getCachedRefs(cache, fullName).catch(() => null);
      if (!snapshot) {
        try {
          snapshot = await stub.listRefs();
          await putCachedRefs(cache, fullName, snapshot);
        } catch {
          snapshot = null;
        }
      }
      const headOid = snapshot ? headOidFromRefs(snapshot) : null;
      if (headOid) {
        const bodyHash = hashFetchBody(body);
        const cached = await getCachedPack(cache, fullName, headOid, bodyHash);
        if (cached) {
          return new Response(cached as unknown as BodyInit, {
            status: 200,
            headers: { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' },
          });
        }
        const res = await stub.fetch(new Request('https://do/git-upload-pack', { method: 'POST', body: body as unknown as BodyInit }));
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (res.ok) await putCachedPack(cache, fullName, headOid, bodyHash, bytes).catch(() => undefined);
        return new Response(bytes, {
          status: res.status,
          headers: { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' },
        });
      }
    } catch {
      // Fail open — fall through to a direct DO fetch below.
    }
    const res = await stub.fetch(new Request('https://do/git-upload-pack', { method: 'POST', body: body as unknown as BodyInit }));
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' },
    });
  });

  app.post('/:owner/:repo/git-receive-pack', async (c) => {
    const owner = c.req.param('owner');
    const repoParam = c.req.param('repo');
    const repoName = RepoFullName.normalizeRepo(repoParam);
    if (!RepoFullName.tryParse(owner, repoName)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Edge-Git"' },
      });
    }
    const auth = await gitAuthForRepo(c, owner, repoName, 'git-receive-pack');
    if (auth instanceof Response) return auth;
    const maxPackBytes = ConfigurationManager.repo.getMaxPackBytes(c.env);
    const contentLength = parseContentLength(c.req.header('Content-Length'));
    if (contentLength !== null && contentLength > maxPackBytes) {
      return c.text(`ERR pack too large: ${contentLength} > ${maxPackBytes} bytes`, 413);
    }
    const fullName = `${owner}/${repoName}`;
    const stub = getRepoStub(c.env, fullName);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > maxPackBytes) {
      return c.text(`ERR pack too large: ${body.byteLength} > ${maxPackBytes} bytes`, 413);
    }
    // Push-time secret scanning (warn by default, block when configured).
    // Warn mode lets the push through and flags it via a response header;
    // block mode rejects the whole push pre-receive style like branch
    // protection. Scanning runs on the raw pack bytes in the API layer so
    // the DO stays D1-free.
    let secretWarning = 0;
    try {
      const mode = await getScope(c).get(Tokens.SecuritySettingsService).getMode(auth.repo.id);
      if (mode !== 'off') {
        const findings = scanBytes(body);
        if (findings.length > 0) {
          if (mode === 'block') {
            const ids = findings.map((f) => f.ruleId).join(', ');
            let refNames: string[] = [];
            try {
              refNames = parseReceivePackRequest(body).commands.map((cmd) => cmd.ref);
            } catch {
              refNames = [];
            }
            if (refNames.length === 0) return c.text(`push blocked: possible secret detected (${ids})`, 403);
            const blocked = buildReportStatus(
              refNames.map((ref) => ({ ref, ok: false as const, error: `push blocked: possible secret detected (${ids})` })),
              true,
            );
            return new Response(blocked.body, {
              status: blocked.status,
              headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' },
            });
          }
          secretWarning = findings.length;
        }
      }
    } catch {
      // Fail closed: without the mode we cannot know whether the operator
      // configured `block`. A D1 outage must not silently downgrade to `off`.
      return c.text('secret scan unavailable; try again later', 503);
    }
    // Branch protection is resolved here (D1) and passed into the DO (which
    // owns git truth but cannot read D1). Protection resolution is fail-closed:
    // a D1 failure rejects the push with 503 instead of pushing unprotected.
    // Unparseable bodies are 400 (the DO would reject them anyway, but
    // without protections the require_pr gate could be bypassed).
    let protections: ProtectedRefRule[];
    try {
      protections = await resolvePushProtections(c.env, auth.repo.id, body);
    } catch (error) {
      if (error instanceof PushProtectionsUnavailableError) {
        return c.text('push protections unavailable; try again later', 503);
      }
      return c.text('invalid push request', 400);
    }
    const res = await stub.receivePack(body, protections);
    // Refs changed: drop cached snapshots so later reads see the new tips.
    // Best-effort via `waitUntil` — never blocks the push response, and KV
    // misses simply recompute from the DO.
    try {
      const cache = getScope(c).get(Tokens.KvCache);
      c.executionCtx.waitUntil(invalidateRepoCaches(cache, fullName).catch(() => undefined));
    } catch {
      // No execution context in tests — invalidation is best-effort.
    }
    if (res.ok && auth.userEmail) {
      try {
        const { commands } = parseReceivePackRequest(body);
        const branches = commands.map((cmd) => branchNameFromRef(cmd.ref)).filter((b): b is string => b !== null);
        const headOid = commands.find((cmd) => branchNameFromRef(cmd.ref))?.newOid ?? null;
        await recordAndNotify(c.env, {
          repositoryId: auth.repo.id,
          fullName,
          actorEmail: auth.userEmail,
          type: 'push',
          title:
            branches.length > 0
              ? `Pushed to ${branches.slice(0, 3).join(', ')}${branches.length > 3 ? ` and ${branches.length - 3} more` : ''}`
              : 'Pushed commits',
          subjectOid: headOid,
          payload: { refs: branches.slice(0, 10), count: commands.length },
        });
        // CI: auto-queue required status checks for each pushed branch head.
        // Best-effort — never fails the push response.
        for (const cmd of commands) {
          const branch = branchNameFromRef(cmd.ref);
          if (!branch || !cmd.newOid || /^0{40}$/.test(cmd.newOid)) continue;
          await triggerRequiredChecks(c.env, {
            repositoryId: auth.repo.id,
            fullName,
            branch,
            headSha: cmd.newOid,
            actorEmail: auth.userEmail,
          }).catch(() => undefined);
        }
      } catch {
        // push succeeded; social bookkeeping must not fail the response
      }
    }
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/x-git-receive-pack-result',
        'Cache-Control': 'no-cache',
        ...(secretWarning > 0 && {
          'X-EdgeGit-Secret-Warning': `${secretWarning} possible secret(s) detected; rotate any exposed credentials`,
        }),
      },
    });
  });
}

// Map this push's branch commands to their longest-matching protection
// rules. Tags and other non-branch refs never match. Parse failures throw
// PushBodyInvalidError (400); D1 failures throw PushProtectionsUnavailableError
// (503) so callers fail closed instead of pushing unprotected.
class PushProtectionsUnavailableError extends Error {
  constructor() {
    super('push protections unavailable');
    this.name = 'PushProtectionsUnavailableError';
  }
}

class PushBodyInvalidError extends Error {
  constructor() {
    super('invalid push request');
    this.name = 'PushBodyInvalidError';
  }
}

async function resolvePushProtections(env: Env, repositoryId: string, body: Uint8Array): Promise<ProtectedRefRule[]> {
  let commands: Array<{ ref: string }>;
  try {
    commands = parseReceivePackRequest(body).commands;
  } catch {
    throw new PushBodyInvalidError();
  }
  const branches = new Set<string>();
  for (const cmd of commands) {
    const branch = branchNameFromRef(cmd.ref);
    if (branch) branches.add(branch);
  }
  if (branches.size === 0) return [];
  const scope = createRequestScope(env);
  let rules: BranchProtectionRuleMetadata[];
  try {
    rules = await scope.get(Tokens.BranchProtectionService).listRules(repositoryId);
  } catch {
    throw new PushProtectionsUnavailableError();
  }
  if (rules.length === 0) return [];
  const protections: ProtectedRefRule[] = [];
  for (const branch of branches) {
    const rule = BranchProtectionService.matchRule(rules, branch);
    if (rule) {
      protections.push({
        ref: `refs/heads/${branch}`,
        requirePr: rule.requirePr,
        blockForcePush: rule.blockForcePush,
        blockDeletion: rule.blockDeletion,
      });
    }
  }
  return protections;
}

export { registerGitRoutes };
