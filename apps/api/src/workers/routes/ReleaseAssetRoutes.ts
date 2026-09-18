import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { RepoService } from '@edge-git/backend-services/repo';
import { assetNameSchema, decodeBase64Strict, normalizeAssetContentType } from '@edge-git/shared/validation';
import { getRepoStub } from '../repoStub';
import { requireVisibleRepo, resolvePublicViewer, toSafeErrorMessage, toServiceStatus, withPublicRepo } from './PublicViewerResolver';
import { viewerCanSeeDrafts } from './ReleaseRoutes';
import { readJsonBody } from './BodyParser';

type ReleaseAssetApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function decodeBase64ToBytes(raw: string): Uint8Array | null {
  return decodeBase64Strict(raw);
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function downloadResponse(bytes: Uint8Array, contentType: string, filename: string): Response {
  const safe = filename.replaceAll(/["\r\n]/g, '_').slice(0, 200) || 'asset';
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  // `attachment` + `nosniff` so even `text/html`/`image/svg+xml` assets
  // cannot execute in the app origin. PAT-gated and draft assets must never
  // be cached — use `no-store` instead of a 1h private cache.
  return new Response(copy, {
    status: 200,
    headers: {
      'Content-Type': normalizeAssetContentType(contentType),
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function registerReleaseAssetPublicRoutes(app: ReleaseAssetApp): void {
  app.get('/repos/:owner/:repo/releases/:tag/assets', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      try {
        const scope = createRequestScope(c.env);
        const release = await scope.get(Tokens.ReleaseService).getRelease(row.id, c.req.param('tag'));
        if (release.isDraft) {
          const viewerEmail = await resolvePublicViewer(c as never);
          if (!(await viewerCanSeeDrafts(c.env, viewerEmail, row.owner, row.name))) return c.json({ error: 'Not found' }, 404);
        }
        const assets = await scope.get(Tokens.ReleaseService).listAssets(row.id, release.tagName);
        return c.json({ assets });
      } catch {
        return c.json({ assets: [] });
      }
    });
  });

  app.get('/repos/:owner/:repo/releases/:tag/assets/:assetId/download', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      try {
        const scope = createRequestScope(c.env);
        const release = await scope.get(Tokens.ReleaseService).getRelease(row.id, c.req.param('tag'));
        if (release.isDraft) {
          const viewerEmail = await resolvePublicViewer(c as never);
          if (!(await viewerCanSeeDrafts(c.env, viewerEmail, row.owner, row.name))) return c.json({ error: 'Not found' }, 404);
        }
        const asset = await scope.get(Tokens.ReleaseService).getAsset(row.id, release.tagName, c.req.param('assetId'));
        const bytes = await getRepoStub(c.env, `${row.owner}/${row.name}`).getReleaseAsset({
          releaseId: asset.releaseId,
          assetId: asset.id,
        });
        if (!bytes || bytes.byteLength === 0) return c.json({ error: 'Not found' }, 404);
        return downloadResponse(bytes, asset.contentType, asset.name);
      } catch (error) {
        return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
      }
    });
  });
}

function registerReleaseAssetUserRoutes(app: ReleaseAssetApp): void {
  app.get('/user/repos/:owner/:repo/releases/:tag/assets', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      const scope = createRequestScope(c.env);
      const release = await scope.get(Tokens.ReleaseService).getRelease(row.id, c.req.param('tag'));
      if (release.isDraft && !(await viewerCanSeeDrafts(c.env, email, owner, repoName))) return c.json({ error: 'Not found' }, 404);
      const assets = await scope.get(Tokens.ReleaseService).listAssets(row.id, release.tagName);
      return c.json({ assets });
    } catch {
      return c.json({ assets: [] });
    }
  });

  app.post('/user/repos/:owner/:repo/releases/:tag/assets', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const { malformed, body } = await readJsonBody<{ name?: unknown; contentBase64?: unknown; contentType?: unknown }>(c);
    if (malformed) return c.json({ error: 'Invalid JSON body' }, 400);
    if (typeof body.name !== 'string' || typeof body.contentBase64 !== 'string' || !body.contentBase64) {
      return c.json({ error: 'name and contentBase64 are required' }, 400);
    }
    if (!assetNameSchema.safeParse(body.name).success) return c.json({ error: 'Invalid asset name' }, 400);
    const maxBytes = ConfigurationManager.releases.getMaxAssetBytes(c.env);
    // Pre-decode tripwire on base64 length so oversized bodies 413 without a
    // full `atob` allocation burn.
    if (body.contentBase64.length > Math.ceil(maxBytes * 1.4) + 4) {
      return c.json({ error: `asset size must be 1-${maxBytes} bytes` }, 413);
    }
    const bytes = decodeBase64ToBytes(body.contentBase64);
    if (!bytes) return c.json({ error: 'contentBase64 must be valid base64' }, 400);
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
      return c.json({ error: `asset size must be 1-${maxBytes} bytes` }, 413);
    }
    try {
      const scope = createRequestScope(c.env);
      const sha256 = await sha256HexBytes(bytes);
      const asset = await scope
        .get(Tokens.ReleaseService)
        .createAsset(row.id, c.req.param('tag'), { name: body.name, size: bytes.byteLength, contentType: normalizeAssetContentType(body.contentType), sha256 }, email);
      const stored = (await getRepoStub(c.env, `${row.owner}/${row.name}`).storeReleaseAsset({
        releaseId: asset.releaseId,
        assetId: asset.id,
        bytes,
      })) as { ok?: boolean; error?: string };
      if (!stored?.ok) {
        await scope
          .get(Tokens.ReleaseService)
          .deleteAsset(row.id, c.req.param('tag'), asset.id)
          .catch(() => undefined);
        return c.json({ error: typeof stored?.error === 'string' ? stored.error : 'Failed to store asset bytes' }, 500);
      }
      return c.json({ asset }, 201);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to upload asset') }, toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/releases/:tag/assets/:assetId/download', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      const scope = createRequestScope(c.env);
      const release = await scope.get(Tokens.ReleaseService).getRelease(row.id, c.req.param('tag'));
      if (release.isDraft && !(await viewerCanSeeDrafts(c.env, email, owner, repoName))) return c.json({ error: 'Not found' }, 404);
      const asset = await scope.get(Tokens.ReleaseService).getAsset(row.id, release.tagName, c.req.param('assetId'));
      const bytes = await getRepoStub(c.env, `${row.owner}/${row.name}`).getReleaseAsset({ releaseId: asset.releaseId, assetId: asset.id });
      if (!bytes || bytes.byteLength === 0) return c.json({ error: 'Not found' }, 404);
      return downloadResponse(bytes, asset.contentType, asset.name);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/releases/:tag/assets/:assetId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    try {
      const scope = createRequestScope(c.env);
      const asset = await scope.get(Tokens.ReleaseService).getAsset(row.id, c.req.param('tag'), c.req.param('assetId'));
      try {
        await getRepoStub(c.env, `${row.owner}/${row.name}`).deleteReleaseAsset({ releaseId: asset.releaseId, assetId: asset.id });
      } catch {
        // best-effort DO cleanup
      }
      await scope.get(Tokens.ReleaseService).deleteAsset(row.id, c.req.param('tag'), asset.id);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });
}

export { registerReleaseAssetPublicRoutes, registerReleaseAssetUserRoutes };
export type { ReleaseAssetApp };
