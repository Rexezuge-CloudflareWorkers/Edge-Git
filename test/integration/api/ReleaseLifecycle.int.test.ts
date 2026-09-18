import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'release-demo';
const OTHER_OWNER = 'release-other';
const OTHER_REPO = 'other-demo';
const OTHER_EMAIL = 'other@example.com';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(method: string, path: string, body?: unknown): Promise<Response> {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

describe('release lifecycle on real D1', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO });
    // Second public repo owned by someone else: the DEV_AUTH_EMAIL viewer
    // (`test@example.com`) holds read-only access there, so draft-hiding
    // behavior can be asserted despite DEV mode authenticating every request.
    const otherRepoId = await seedRepo(testEnv.DB, { ownerEmail: OTHER_EMAIL, owner: OTHER_OWNER, name: OTHER_REPO });
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(
      'INSERT INTO releases (id, repository_id, tag_name, name, body, is_draft, is_prerelease, created_by, created_at, published_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, NULL)',
    )
      .bind(crypto.randomUUID(), otherRepoId, 'v0.0.1-draft', 'Hidden Draft', '', OTHER_EMAIL, now)
      .run();
  });

  it('creates a draft release and lists it (owner + public)', async () => {
    const created = await json('POST', `/user/repos/${OWNER}/${REPO}/releases`, { tagName: 'v0.1.0', name: 'First', body: 'Notes' });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { release: { tagName: string; isDraft: boolean } };
    expect(createdBody.release.tagName).toBe('v0.1.0');
    expect(createdBody.release.isDraft).toBe(true);

    const owned = await api(`/user/repos/${OWNER}/${REPO}/releases`);
    expect(owned.status).toBe(200);
    const ownedBody = (await owned.json()) as { releases: Array<{ tagName: string }> };
    expect(ownedBody.releases.map((r) => r.tagName)).toContain('v0.1.0');

    const pub = await api(`/repos/${OWNER}/${REPO}/releases`);
    expect(pub.status).toBe(200);
    // DEV_AUTH_EMAIL authenticates public reads as the repo owner, so the
    // owner sees their own draft here; anonymous hiding is covered below via
    // the other-owner repo where the viewer is read-only.
    const pubBody = (await pub.json()) as { releases: Array<{ tagName: string }> };
    expect(pubBody.releases.map((r) => r.tagName)).toContain('v0.1.0');
  });

  it('hides drafts from read-only viewers (public + user routes)', async () => {
    const pubList = await api(`/repos/${OTHER_OWNER}/${OTHER_REPO}/releases`);
    expect(pubList.status).toBe(200);
    expect(((await pubList.json()) as { releases: unknown[] }).releases).toHaveLength(0);

    expect((await api(`/repos/${OTHER_OWNER}/${OTHER_REPO}/releases/v0.0.1-draft`)).status).toBe(404);

    const userList = await api(`/user/repos/${OTHER_OWNER}/${OTHER_REPO}/releases`);
    expect(userList.status).toBe(200);
    expect(((await userList.json()) as { releases: unknown[] }).releases).toHaveLength(0);

    expect((await api(`/user/repos/${OTHER_OWNER}/${OTHER_REPO}/releases/v0.0.1-draft`)).status).toBe(404);
  });

  it('rejects duplicate tags and invalid names', async () => {
    expect((await json('POST', `/user/repos/${OWNER}/${REPO}/releases`, { tagName: 'v0.1.0' })).status).toBe(400);
    expect((await json('POST', `/user/repos/${OWNER}/${REPO}/releases`, { tagName: 'bad name' })).status).toBe(400);
    expect((await json('POST', `/user/repos/${OWNER}/${REPO}/releases`, {})).status).toBe(400);
    expect((await json('POST', `/user/repos/${OWNER}/nope/releases`, { tagName: 'v9' })).status).toBe(404);
  });

  it('refuses to publish without a git tag', async () => {
    const direct = await json('POST', `/user/repos/${OWNER}/${REPO}/releases`, { tagName: 'v9.9.9', isDraft: false });
    expect(direct.status).toBe(400);
    const transition = await json('PATCH', `/user/repos/${OWNER}/${REPO}/releases/v0.1.0`, { isDraft: false });
    expect(transition.status).toBe(400);
  });

  it('updates draft metadata and reads it back', async () => {
    const patched = await json('PATCH', `/user/repos/${OWNER}/${REPO}/releases/v0.1.0`, { name: 'First (updated)', isPrerelease: true });
    expect(patched.status).toBe(200);
    const fetched = await api(`/user/repos/${OWNER}/${REPO}/releases/v0.1.0`);
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as { release: { name: string; isPrerelease: boolean }; assets: unknown[] };
    expect(fetchedBody.release.name).toBe('First (updated)');
    expect(fetchedBody.release.isPrerelease).toBe(true);
    expect(fetchedBody.assets).toHaveLength(0);
    // owner (DEV_AUTH_EMAIL) may read their own draft on the public route
    expect((await api(`/repos/${OWNER}/${REPO}/releases/v0.1.0`)).status).toBe(200);
    expect((await api(`/user/repos/${OWNER}/${REPO}/releases/missing`)).status).toBe(404);
  });

  it('uploads, downloads, and deletes assets', async () => {
    const content = toBase64('hello-release-bytes');
    const uploaded = await json('POST', `/user/repos/${OWNER}/${REPO}/releases/v0.1.0/assets`, {
      name: 'hello.txt',
      contentBase64: content,
      contentType: 'text/plain',
    });
    expect(uploaded.status).toBe(201);
    const uploadedBody = (await uploaded.json()) as { asset: { id: string; name: string; size: number } };
    expect(uploadedBody.asset.name).toBe('hello.txt');
    expect(uploadedBody.asset.size).toBe(19);
    const assetId = uploadedBody.asset.id;

    // duplicate names rejected
    expect(
      (await json('POST', `/user/repos/${OWNER}/${REPO}/releases/v0.1.0/assets`, { name: 'hello.txt', contentBase64: content })).status,
    ).toBe(400);
    // invalid payloads rejected
    expect(
      (await json('POST', `/user/repos/${OWNER}/${REPO}/releases/v0.1.0/assets`, { name: 'x.bin', contentBase64: '!!!' })).status,
    ).toBe(400);

    const listed = await api(`/user/repos/${OWNER}/${REPO}/releases/v0.1.0/assets`);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { assets: Array<{ id: string }> };
    expect(listedBody.assets.map((a) => a.id)).toContain(assetId);

    const downloaded = await api(`/user/repos/${OWNER}/${REPO}/releases/v0.1.0/assets/${assetId}/download`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('Content-Type')).toContain('text/plain');
    expect(await downloaded.text()).toBe('hello-release-bytes');

    // DEV_AUTH_EMAIL reads as the owner, so the public download serves the
    // owner's own draft asset; draft hiding is asserted at the release level
    // above (the download route shares the same gate).
    const pubDownload = await api(`/repos/${OWNER}/${REPO}/releases/v0.1.0/assets/${assetId}/download`);
    expect(pubDownload.status).toBe(200);
    expect(await pubDownload.text()).toBe('hello-release-bytes');

    const deleted = await api(`/user/repos/${OWNER}/${REPO}/releases/v0.1.0/assets/${assetId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await api(`/user/repos/${OWNER}/${REPO}/releases/v0.1.0/assets/${assetId}/download`)).status).toBe(404);
  });

  it('deletes the release', async () => {
    const deleted = await api(`/user/repos/${OWNER}/${REPO}/releases/v0.1.0`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await api(`/user/repos/${OWNER}/${REPO}/releases/v0.1.0`)).status).toBe(404);
    expect((await api(`/user/repos/${OWNER}/${REPO}/releases/v0.1.0`, { method: 'DELETE' })).status).toBe(404);
  });
});
