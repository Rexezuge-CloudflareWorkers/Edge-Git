import type { Hono } from 'hono';
import { gitAuthForRepo } from '@/middleware';
import { getRepoStub } from '../repoStub';
import { advertiseUploadPack, advertiseReceivePack, branchNameFromRef, buildReportStatus, parseReceivePackRequest } from '@edge-git/git-protocol';
import type { ProtectedRefRule } from '@edge-git/git-protocol';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { BranchProtectionService } from '@edge-git/backend-services/protection';
import { scanBytes } from '@edge-git/backend-services/security';
import { RepoService } from '@edge-git/backend-services/repo';
import { recordAndNotify } from './SocialEmit';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';

type GitApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

// Git Smart HTTP — must stay outside Access auth (PAT/anonymous).
function registerGitRoutes(app: GitApp): void {
  app.get('/:owner/:repo/info/refs', async (c) => {
    const owner = c.req.param('owner');
    const repoParam = c.req.param('repo');
    const repoName = RepoService.normalizeRepo(repoParam);
    const service = new URL(c.req.url).searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return c.text('Invalid service', 400);
    }
    const auth = await gitAuthForRepo(c as never, owner, repoName, service);
    if (auth instanceof Response) return auth;
    if (service === 'git-upload-pack') {
      return advertiseUploadPack();
    }
    const fullName = `${owner}/${repoName}`;
    const stub = getRepoStub(c.env, fullName);
    return advertiseReceivePack(() => stub.listRefs());
  });

  app.post('/:owner/:repo/git-upload-pack', async (c) => {
    const owner = c.req.param('owner');
    const repoParam = c.req.param('repo');
    const repoName = RepoService.normalizeRepo(repoParam);
    const auth = await gitAuthForRepo(c as never, owner, repoName, 'git-upload-pack');
    if (auth instanceof Response) return auth;
    const maxFetchBodyBytes = ConfigurationManager.repo.getMaxFetchBodyBytes(c.env);
    const contentLength = Number(c.req.header('Content-Length'));
    if (Number.isSafeInteger(contentLength) && contentLength > maxFetchBodyBytes) {
      return c.text(`ERR fetch request too large: ${contentLength} > ${maxFetchBodyBytes} bytes`, 413);
    }
    const fullName = `${owner}/${repoName}`;
    const stub = getRepoStub(c.env, fullName);
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > maxFetchBodyBytes) {
      return c.text(`ERR fetch request too large: ${body.byteLength} > ${maxFetchBodyBytes} bytes`, 413);
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
    const repoName = RepoService.normalizeRepo(repoParam);
    const auth = await gitAuthForRepo(c as never, owner, repoName, 'git-receive-pack');
    if (auth instanceof Response) return auth;
    const maxPackBytes = ConfigurationManager.repo.getMaxPackBytes(c.env);
    const contentLength = Number(c.req.header('Content-Length'));
    if (Number.isSafeInteger(contentLength) && contentLength > maxPackBytes) {
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
      const mode = await createRequestScope(c.env).get(Tokens.SecuritySettingsService).getMode(auth.repo.id);
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
      // Scanning never fails the push; block-mode errors above return early.
    }
    // Branch protection is resolved here (D1) and passed into the DO (which
    // owns git truth but cannot read D1). Unresolvable (legacy DBs) means
    // no rules — the DO then behaves as before.
    const protections = await resolvePushProtections(c.env, auth.repo.id, body).catch(() => []);
    const res = await stub.receivePack(body, protections);
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
          title: branches.length > 0 ? `Pushed to ${branches.slice(0, 3).join(', ')}${branches.length > 3 ? ` and ${branches.length - 3} more` : ''}` : 'Pushed commits',
          subjectOid: headOid,
          payload: { refs: branches.slice(0, 10), count: commands.length },
        });
      } catch {
        // push succeeded; social bookkeeping must not fail the response
      }
    }
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/x-git-receive-pack-result',
        'Cache-Control': 'no-cache',
        ...((secretWarning > 0) && { 'X-EdgeGit-Secret-Warning': `${secretWarning} possible secret(s) detected; rotate any exposed credentials` }),
      },
    });
  });
}

// Map this push's branch commands to their longest-matching protection
// rules. Tags and other non-branch refs never match.
async function resolvePushProtections(env: Env, repositoryId: string, body: Uint8Array): Promise<ProtectedRefRule[]> {
  const { commands } = parseReceivePackRequest(body);
  const branches = new Set<string>();
  for (const cmd of commands) {
    const branch = branchNameFromRef(cmd.ref);
    if (branch) branches.add(branch);
  }
  if (branches.size === 0) return [];
  const scope = createRequestScope(env);
  const rules = await scope.get(Tokens.BranchProtectionService).listRules(repositoryId);
  if (rules.length === 0) return [];
  const protections: ProtectedRefRule[] = [];
  for (const branch of branches) {
    const rule = BranchProtectionService.matchRule(rules, branch);
    if (rule) {
      protections.push({ ref: `refs/heads/${branch}`, requirePr: rule.requirePr, blockForcePush: rule.blockForcePush, blockDeletion: rule.blockDeletion });
    }
  }
  return protections;
}

export { registerGitRoutes };
