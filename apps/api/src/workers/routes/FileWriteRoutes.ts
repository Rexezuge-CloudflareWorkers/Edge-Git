import type { Hono } from 'hono';
import { getRepoStub } from '../repoStub';
import { requireVisibleRepo, toServiceStatus } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';

type RepoApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

type FileResult = { ok: boolean; error?: string; status?: number } & Record<string, unknown>;

function toFileResponse(
  result: FileResult,
  successStatus: 200 | 201,
): { body: unknown; status: 200 | 201 | 400 | 403 | 404 | 409 | 413 | 500 } {
  if (!result.ok) {
    const status = [400, 404, 409, 413].includes(result.status ?? 0) ? (result.status as 400 | 404 | 409 | 413) : 500;
    return { body: { error: result.error ?? 'File operation failed' }, status };
  }
  return { body: result, status: successStatus };
}

async function requireWriteRole(env: Env, owner: string, repoName: string, email: string): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  const row = await requireVisibleRepo(env, owner, repoName, email);
  if (!row) return { ok: false, status: 404 };
  try {
    await createRequestScope(env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    return { ok: true };
  } catch {
    return { ok: false, status: 403 };
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

function decodeBase64(input: string): Uint8Array | null {
  try {
    const clean = input.replaceAll(/\s/g, '');
    if (clean.length % 4 === 1 || !/^[a-z0-9+/]*={0,2}$/i.test(clean)) return null;
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0;
    return bytes;
  } catch {
    return null;
  }
}

function parseExpectedOid(value: unknown): { ok: true; value: string | null | undefined } | { ok: false } {
  if (typeof value !== 'string') return { ok: true, value: undefined };
  if (value === '') return { ok: true, value: undefined };
  if (!/^[0-9a-f]{40}$/i.test(value)) return { ok: false };
  return { ok: true, value };
}

// Authenticated single-file writes — `write+` only. POST upserts UTF-8 text
// files (create or update, binary rejected); DELETE removes a file. Both
// accept an optional `expectedOid` branch tip for optimistic concurrency
// (409 when the branch moved since the editor loaded it).
function registerFileWriteRoutes(app: RepoApp): void {
  app.post('/user/repos/:owner/:repo/contents', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const body = (await c.req.json().catch(() => ({}))) as {
      branch?: string;
      path?: string;
      contentBase64?: string;
      message?: string;
      expectedOid?: string | null;
    };
    const branch = (body.branch ?? '').trim();
    if (!branch) return c.json({ error: 'branch is required' }, 400);
    const filePath = (body.path ?? '').trim();
    if (!filePath) return c.json({ error: 'path is required' }, 400);
    if (typeof body.contentBase64 !== 'string') return c.json({ error: 'contentBase64 is required' }, 400);
    const expected = parseExpectedOid(body.expectedOid);
    if (!expected.ok) return c.json({ error: 'expectedOid must be a 40-char hex string' }, 400);
    const content = decodeBase64(body.contentBase64);
    if (!content) return c.json({ error: 'contentBase64 is not valid base64' }, 400);
    const maxFileBytes = ConfigurationManager.repo.getMaxFileBytes(c.env);
    if (content.byteLength > maxFileBytes) return c.json({ error: `file too large (max ${maxFileBytes} bytes)` }, 413);
    try {
      const gate = await requireWriteRole(c.env, owner, repoName, email);
      if (!gate.ok) return c.json({ error: gate.status === 404 ? 'Not found' : 'Forbidden' }, gate.status);
      const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
      const message = (rawMessage || `Update ${filePath}`).slice(0, 1000);
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
      return c.json(out, status);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to save file' }, toServiceStatus(error));
    }
  });

  // Delete takes query params because branch names may contain slashes
  // (same convention as `DELETE .../branches?branch=`).
  app.delete('/user/repos/:owner/:repo/contents', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const params = new URL(c.req.url).searchParams;
    const branch = (params.get('branch') ?? '').trim();
    if (!branch) return c.json({ error: 'branch query param is required' }, 400);
    const filePath = (params.get('path') ?? '').trim();
    if (!filePath) return c.json({ error: 'path query param is required' }, 400);
    const expected = parseExpectedOid(params.get('expectedOid'));
    if (!expected.ok) return c.json({ error: 'expectedOid must be a 40-char hex string' }, 400);
    try {
      const gate = await requireWriteRole(c.env, owner, repoName, email);
      if (!gate.ok) return c.json({ error: gate.status === 404 ? 'Not found' : 'Forbidden' }, gate.status);
      const rawMessage = (params.get('message') ?? '').trim();
      const message = (rawMessage || `Delete ${filePath}`).slice(0, 1000);
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
      return c.json(out, status);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to delete file' }, toServiceStatus(error));
    }
  });
}

export { registerFileWriteRoutes };
