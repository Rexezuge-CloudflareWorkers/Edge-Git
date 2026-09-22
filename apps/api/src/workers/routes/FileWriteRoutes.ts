import type { Hono } from 'hono';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { getRepoStub } from '../doStubs';
import { jsonError, requireVisibleRepo, toErrorBody, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { branchNameSchema, decodeBase64Strict, sanitizeCommitMessage } from '@edge-git/shared/validation';
import { scanBytes } from '@edge-git/backend-services/security';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { readJsonBody } from './BodyParser';

type RepoApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

type FileResult = { ok: boolean; error?: string; status?: number } & Record<string, unknown>;

function toFileResponse(
  result: FileResult,
  successStatus: 200 | 201,
): { body: unknown; status: 200 | 201 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 } {
  if (!result.ok) {
    const status = [400, 401, 403, 404, 409, 413, 429].includes(result.status ?? 0)
      ? (result.status as 400 | 401 | 403 | 404 | 409 | 413 | 429)
      : 500;
    return { body: toErrorBody(status, result.error ?? 'File operation failed'), status };
  }
  return { body: result, status: successStatus };
}

async function requireWriteRole(
  env: Env,
  owner: string,
  repoName: string,
  email: string,
): Promise<{ ok: true; repo: RepositoryRow } | { ok: false; status: 403 | 404 }> {
  const row = await requireVisibleRepo(env, owner, repoName, email);
  if (!row) return { ok: false, status: 404 };
  try {
    await createRequestScope(env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    return { ok: true, repo: row };
  } catch {
    return { ok: false, status: 403 };
  }
}

// Direct web commits to a `require_pr` branch must go through a pull
// request instead. Returns a 403 response when blocked, a 503 when the rule
// lookup fails (fail closed), else null.
async function checkProtectedBranch(env: Env, repoId: string, branch: string): Promise<{ error: string } | { unavailable: true } | null> {
  try {
    const rule = await createRequestScope(env).get(Tokens.BranchProtectionService).matchForRepo(repoId, branch);
    if (rule?.requirePr) return { error: `branch "${branch}" is protected: open a pull request instead` };
    return null;
  } catch {
    return { unavailable: true };
  }
}

// Best-effort code search indexing for web file writes. Push indexing is
// covered by the SearchBackfillTask cron; this keeps editor saves searchable
// immediately without ever failing the write itself.
function decodeIndexableText(contentBase64: string): string | null {
  try {
    const binary = atob(contentBase64.replaceAll(/\s/g, ''));
    if (binary.length > 20_000) return null;
    const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function indexWrittenFile(env: Env, repoId: string, path: string, contentBase64: string, commitOid: unknown): Promise<void> {
  const text = decodeIndexableText(contentBase64);
  if (text === null) return;
  try {
    await createRequestScope(env)
      .get(Tokens.SearchService)
      .indexFile({
        repoId,
        path,
        oid: typeof commitOid === 'string' ? commitOid : null,
        content: text,
      });
  } catch {
    // Index failures must never fail the file write.
  }
}

async function resolveAuthorName(env: Env, email: string): Promise<string> {
  const fallback = email.split('@', 1)[0].trim() || email;
  try {
    const profile = await createRequestScope(env).get(Tokens.UserService).getProfileByEmail(email);
    return (profile.username ?? '').trim() || fallback;
  } catch {
    return fallback;
  }
}

function waitUntilOf(c: { executionCtx?: unknown }): ((promise: Promise<unknown>) => void) | null {
  try {
    const ctx = c.executionCtx as ExecutionContext | undefined;
    if (typeof ctx?.waitUntil === 'function') return ctx.waitUntil.bind(ctx);
  } catch {
    // ignore — unit tests have no execution context
  }
  return null;
}

function decodeBase64(input: string): Uint8Array | null {
  return decodeBase64Strict(input);
}

function isSafeFilePath(path: string): boolean {
  if (!path || path.length > 512) return false;
  if (path.startsWith('/') || path.includes(String.fromCodePoint(0))) return false;
  if (path.split('/').some((seg) => ['', '.', '..'].includes(seg))) return false;
  return true;
}

function parseExpectedOid(value: unknown): { ok: true; value: string | null | undefined } | { ok: false } {
  if (typeof value !== 'string') return { ok: true, value: undefined };
  if (value === '') return { ok: true, value: undefined };
  if (!/^[0-9a-f]{40}$/i.test(value)) return { ok: false };
  return { ok: true, value };
}

// Push-time secret scanning for web editor saves (warn by default, block
// when configured). Returns a 403 JSON response in block mode, the finding
// count in warn mode (surfaced via response header), or null when clean/off.
// Throws on settings lookup failure so callers fail closed (503) instead of
// silently downgrading a configured `block` to `off`.
async function checkSecretContent(
  env: Env,
  repoId: string,
  content: Uint8Array,
): Promise<{ blocked: { error: string } } | { warning: number } | null> {
  const mode = await createRequestScope(env).get(Tokens.SecuritySettingsService).getMode(repoId);
  if (mode === 'off') return null;
  const findings = scanBytes(content);
  if (findings.length === 0) return null;
  if (mode === 'block') {
    return { blocked: { error: `Save blocked: possible secret detected (${findings.map((f) => f.ruleId).join(', ')})` } };
  }
  return { warning: findings.length };
}

// Authenticated single-file writes — `write+` only. POST upserts UTF-8 text
// files (create or update, binary rejected); DELETE removes a file. Both
// accept an optional `expectedOid` branch tip for optimistic concurrency
// (409 when the branch moved since the editor loaded it).
function registerFileWriteRoutes(app: RepoApp): void {
  app.post('/user/repos/:owner/:repo/contents', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    // Per-route JSON cap before parsing: base64 inflates ~4/3x, so the shared
    // 1MB default would reject max-size file writes with a misleading 400.
    // The byte-exact tripwire below still enforces the file cap as 413.
    const maxFileBytesForCap = ConfigurationManager.repo.getMaxFileBytes(c.env);
    const maxJsonBytes = Math.ceil(maxFileBytesForCap * 1.4) + 4096;
    const { malformed, oversized, body } = await readJsonBody<{
      branch?: string;
      path?: string;
      contentBase64?: string;
      message?: string;
      expectedOid?: string | null;
    }>(c, { maxBytes: maxJsonBytes });
    if (oversized) return jsonError(c, `file too large (max ${maxFileBytesForCap} bytes)`, 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const branch = (body.branch ?? '').trim();
    if (!branch) return jsonError(c, 'branch is required', 400);
    if (!branchNameSchema.safeParse(branch).success) return jsonError(c, 'Invalid branch name', 400);
    const filePath = (body.path ?? '').trim();
    if (!filePath) return jsonError(c, 'path is required', 400);
    if (!isSafeFilePath(filePath)) return jsonError(c, 'path must be a safe relative file path', 400);
    if (typeof body.contentBase64 !== 'string') return jsonError(c, 'contentBase64 is required', 400);
    const expected = parseExpectedOid(body.expectedOid);
    if (!expected.ok) return jsonError(c, 'expectedOid must be a 40-char hex string', 400);
    const maxFileBytes = ConfigurationManager.repo.getMaxFileBytes(c.env);
    try {
      const gate = await requireWriteRole(c.env, owner, repoName, email);
      if (!gate.ok) return jsonError(c, gate.status === 404 ? 'Not found' : 'Forbidden', gate.status);
      // Size tripwire AFTER auth so unauthenticated callers cannot oracle
      // max-file-bytes vs auth failures via 413-vs-401 distinctions.
      if (body.contentBase64.length > Math.ceil(maxFileBytes * 1.4) + 4) {
        return jsonError(c, `file too large (max ${maxFileBytes} bytes)`, 413);
      }
      const content = decodeBase64(body.contentBase64);
      if (!content) return jsonError(c, 'contentBase64 is not valid base64', 400);
      if (content.byteLength > maxFileBytes) return jsonError(c, `file too large (max ${maxFileBytes} bytes)`, 413);
      const blocked = await checkProtectedBranch(c.env, gate.repo.id, branch);
      if (blocked && 'unavailable' in blocked) return jsonError(c, 'Branch protection unavailable; try again later', 503);
      if (blocked) return jsonError(c, blocked.error, 403);
      let secret: { blocked: { error: string } } | { warning: number } | null;
      try {
        secret = await checkSecretContent(c.env, gate.repo.id, content);
      } catch {
        return jsonError(c, 'Secret scan unavailable; try again later', 503);
      }
      if (secret && 'blocked' in secret) return jsonError(c, secret.blocked.error, 403);
      const secretWarning = secret && 'warning' in secret ? secret.warning : 0;
      const message = sanitizeCommitMessage(body.message, `Update ${filePath}`);
      const result = (await getRepoStub(c.env, `${owner}/${repoName}`).commitFile({
        branch,
        path: filePath,
        content,
        message,
        expectedOid: expected.value,
        authorName: await resolveAuthorName(c.env, email),
        authorEmail: email,
      })) as FileResult;
      const { body: out, status } = toFileResponse(result, result.ok && (result as { created?: boolean }).created ? 201 : 200);
      if (result.ok) {
        waitUntilOf(c)?.(
          indexWrittenFile(c.env, gate.repo.id, filePath, body.contentBase64, (result as { commitOid?: unknown }).commitOid).catch(
            () => undefined,
          ),
        );
      }
      if (secretWarning > 0)
        c.header('X-EdgeGit-Secret-Warning', `${secretWarning} possible secret(s) detected; rotate any exposed credentials`);
      return c.json(out, status);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to save file'), toServiceStatus(error));
    }
  });

  // Delete takes query params because branch names may contain slashes
  // (same convention as `DELETE .../branches?branch=`).
  app.delete('/user/repos/:owner/:repo/contents', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const params = new URL(c.req.url).searchParams;
    const branch = (params.get('branch') ?? '').trim();
    if (!branch) return jsonError(c, 'branch query param is required', 400);
    if (!branchNameSchema.safeParse(branch).success) return jsonError(c, 'Invalid branch name', 400);
    const filePath = (params.get('path') ?? '').trim();
    if (!filePath) return jsonError(c, 'path query param is required', 400);
    if (!isSafeFilePath(filePath)) return jsonError(c, 'path must be a safe relative file path', 400);
    const expected = parseExpectedOid(params.get('expectedOid'));
    if (!expected.ok) return jsonError(c, 'expectedOid must be a 40-char hex string', 400);
    try {
      const gate = await requireWriteRole(c.env, owner, repoName, email);
      if (!gate.ok) return jsonError(c, gate.status === 404 ? 'Not found' : 'Forbidden', gate.status);
      const blocked = await checkProtectedBranch(c.env, gate.repo.id, branch);
      if (blocked && 'unavailable' in blocked) return jsonError(c, 'Branch protection unavailable; try again later', 503);
      if (blocked) return jsonError(c, blocked.error, 403);
      const message = sanitizeCommitMessage(params.get('message'), `Delete ${filePath}`);
      const result = (await getRepoStub(c.env, `${owner}/${repoName}`).commitFile({
        branch,
        path: filePath,
        content: null,
        message,
        expectedOid: expected.value,
        authorName: await resolveAuthorName(c.env, email),
        authorEmail: email,
      })) as FileResult;
      const { body: out, status } = toFileResponse(result, 200);
      if (result.ok) {
        try {
          await getScope(c).get(Tokens.SearchService).removeFile(gate.repo.id, filePath);
        } catch {
          // Index failures must never fail the file delete.
        }
      }
      return c.json(out, status);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to delete file'), toServiceStatus(error));
    }
  });
}

export { registerFileWriteRoutes, isSafeFilePath };
