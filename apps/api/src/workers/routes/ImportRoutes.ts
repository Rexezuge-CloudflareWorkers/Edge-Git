import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { presentSingle } from './IdentityPresenter';
import { RepoFullName } from '@edge-git/shared/utils';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { runImportJob } from '@edge-git/background/transfer/ImportRunner';
import { getRepoStub } from '../doStubs';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type TransferApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function waitUntilOf(c: { executionCtx?: unknown }): ((promise: Promise<unknown>) => void) | null {
  try {
    const ctx = c.executionCtx as ExecutionContext | undefined;
    if (typeof ctx?.waitUntil === 'function') return ctx.waitUntil.bind(ctx);
  } catch {
    // ignore — unit tests have no execution context
  }
  return null;
}

// Repository import from a public https git remote. Imports target empty
// repos only; the job fetches the remote advertisement + packfile over
// Smart HTTP (no credentials are persisted) and indexes it into the repo
// DO. An immediate `waitUntil` attempt runs inline; the cron sweeper
// retries whatever is left pending.
function registerImportRoutes(app: TransferApp): void {
  app.post('/user/repos/:owner/:repo/import', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const { malformed, oversized, body } = await readJsonBody<{ sourceUrl?: string }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.sourceUrl !== 'string' || !body.sourceUrl.trim()) return jsonError(c, 'sourceUrl is required', 400);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const job = await scope.get(Tokens.ImportService).createJob(repo.id, body.sourceUrl, email);
      const fullName = `${owner}/${repoName}`;
      const waitUntil = waitUntilOf(c);
      if (waitUntil) waitUntil(runImportJob(c.env, fullName, job.id).catch(() => undefined));
      return c.json({ job: await presentSingle(scope, job) }, 202);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to start import'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/import', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'read');
      const job = await scope.get(Tokens.ImportService).latestForRepo(repo.id);
      if (!job) return jsonError(c, 'No import found', 404);
      return c.json({ job: await presentSingle(scope, job) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to load import'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/import/:jobId/cancel', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const job = await scope.get(Tokens.ImportService).cancelJob(c.req.param('jobId'), repo.id);
      return c.json({ job: await presentSingle(scope, job) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to cancel import'), toServiceStatus(error));
    }
  });

  // Bundle export: refs + base64 packfile for the repo's heads/tags.
  // Bounded by MAX_EXPORT_BYTES; over-limit repos fail closed with 413
  // (use `git push --mirror` to a new remote instead).
  app.get('/user/repos/:owner/:repo/export', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'read');
      const stub = getRepoStub(c.env, `${owner}/${repoName}`);
      const listed = (await stub.listRefs()) as { refs: Array<{ ref: string; oid: string }> };
      const heads = (listed.refs ?? []).filter((r) => r.ref.startsWith('refs/heads/') || r.ref.startsWith('refs/tags/'));
      if (heads.length === 0) return jsonError(c, 'Repository is empty', 404);
      const exported = await stub.exportPack(heads.map((r) => r.oid));
      if (!exported.pack || exported.pack.byteLength === 0) return jsonError(c, 'Nothing to export', 404);
      const maxBytes = ConfigurationManager.transfer.getMaxExportBytes(c.env);
      if (exported.pack.byteLength > maxBytes) {
        return jsonError(c, `Repository too large to export (${exported.pack.byteLength} > ${maxBytes} bytes)`, 413);
      }
      let packBase64 = '';
      const bytes = exported.pack;
      const CHUNK = 32_768;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const window = bytes.subarray(i, i + CHUNK);
        let binary = '';
        for (const byte of window) binary += String.fromCodePoint(byte);
        packBase64 += binary;
      }
      return c.json({ refs: heads, oids: exported.oids, byteLength: bytes.byteLength, packBase64: btoa(packBase64) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to export repository'), toServiceStatus(error));
    }
  });
}

export { registerImportRoutes };
