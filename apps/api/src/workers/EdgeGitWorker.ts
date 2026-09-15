import { AbstractEntrypointWorker } from '@edge-git/backend-runtime/base';
import { fromHono } from 'chanfana';
import type { HonoOpenAPIRouterType } from 'chanfana';
import { Hono } from 'hono';
import { MiddlewareHandlers, gitAuthForRepo } from '@/middleware';
import { getRepoStub, ensureRepo } from './repoStub';
import { advertiseUploadPack, advertiseReceivePack } from '@edge-git/git-protocol';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { RepoServiceFactory } from '@edge-git/backend-services/repo';
import { IssueServiceFactory } from '@edge-git/backend-services/issue';
import { TokenServiceFactory } from '@edge-git/backend-services/auth';
import { RepoService } from '@edge-git/backend-services/repo';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { SPA_HTML } from '@/generated/spa-shell';

type AppRouter = HonoOpenAPIRouterType<{
  Bindings: Env;
  Variables: { AuthenticatedUserEmailAddress: string };
}>;

function toRepoJson(r: RepositoryRow): unknown {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    fullName: `${r.owner}/${r.name}`,
    description: r.description,
    isPrivate: r.is_private === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function requireVisibleRepo(env: Env, owner: string, repoName: string, viewerEmail: string): Promise<RepositoryRow | null> {
  const row = await RepoServiceFactory.create({ DB: env.DB }).getByOwnerAndName(owner, repoName);
  if (!row) return null;
  if (row.is_private === 1 && row.owner_email !== viewerEmail) return null;
  return row;
}

class EdgeGitWorker extends AbstractEntrypointWorker {
  protected readonly app: AppRouter;

  constructor() {
    super();

    const app = new Hono<{
      Bindings: Env;
      Variables: { AuthenticatedUserEmailAddress: string };
    }>();

    app.get('/', (c) => c.redirect('/user/'));
    app.get('/user', (c) => c.redirect('/user/' + new URL(c.req.url).search));
    app.get('/health', (c) => c.json({ ok: true, service: 'edge-git' }));

    // Git Smart HTTP — must stay outside Access auth (PAT/anonymous)
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
      const fullName = `${owner}/${repoName}`;
      const stub = getRepoStub(c.env, fullName);
      if (service === 'git-upload-pack') {
        return advertiseUploadPack();
      }
      return advertiseReceivePack(() => stub.listRefs() as Promise<{ refs: Array<{ ref: string; oid: string }>; symbolicHead: string | null }>);
    });

    app.post('/:owner/:repo/git-upload-pack', async (c) => {
      const owner = c.req.param('owner');
      const repoParam = c.req.param('repo');
      const repoName = RepoService.normalizeRepo(repoParam);
      const auth = await gitAuthForRepo(c as never, owner, repoName, 'git-upload-pack');
      if (auth instanceof Response) return auth;
      const fullName = `${owner}/${repoName}`;
      const stub = getRepoStub(c.env, fullName);
      const body = new Uint8Array(await c.req.arrayBuffer());
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
      const fullName = `${owner}/${repoName}`;
      const stub = getRepoStub(c.env, fullName);
      const body = new Uint8Array(await c.req.arrayBuffer());
      const res = await stub.fetch(new Request('https://do/git-receive-pack', { method: 'POST', body: body as unknown as BodyInit }));
      return new Response(res.body, {
        status: res.status,
        headers: { 'Content-Type': 'application/x-git-receive-pack-result', 'Cache-Control': 'no-cache' },
      });
    });

    // Protected UI/API surface
    app.use('/user/*', MiddlewareHandlers.userAuthentication());

    app.get('/user/me', async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      return c.json({ email });
    });

    app.get('/user/repos', async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const rows = await RepoServiceFactory.create({ DB: c.env.DB }).listByOwnerEmail(email, 100);
      return c.json({ repos: rows.map(toRepoJson) });
    });

    app.post('/user/repos', async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const body = (await c.req.json().catch(() => ({}))) as { owner?: string; name?: string; description?: string | null; isPrivate?: boolean };
      const owner = (body.owner ?? email.split('@')[0]).trim();
      const name = (body.name ?? '').trim();
      if (!name) return c.json({ error: 'name is required' }, 400);
      try {
        RepoService.validateNames(owner, RepoService.normalizeRepo(name));
        const svc = RepoServiceFactory.create({ DB: c.env.DB });
        const normalized = RepoService.normalizeRepo(name);
        const { id } = await svc.createRepo(email, owner, normalized, body.description ?? null, body.isPrivate ?? false);
        await ensureRepo(c.env, `${owner}/${normalized}`);
        return c.json({ id, owner, name: normalized, fullName: `${owner}/${normalized}` }, 201);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create repo';
        const status = message.includes('already exists') || message.includes('Invalid') || message.includes('Maximum') ? 400 : 500;
        return c.json({ error: message }, status as 400);
      }
    });

    app.get('/user/repos/:owner/:repo', async (c) => {
      const row = await requireVisibleRepo(
        c.env,
        c.req.param('owner'),
        RepoService.normalizeRepo(c.req.param('repo')),
        c.get('AuthenticatedUserEmailAddress'),
      );
      if (!row) return c.json({ error: 'Not found' }, 404);
      return c.json(toRepoJson(row));
    });

    const openapi: AppRouter = fromHono(app, { docs_url: '/docs' });

    // Read-model passthroughs (branches/tree/blob/commits) via DO RPC
    app.get('/user/repos/:owner/:repo/branches', async (c) => {
      const owner = c.req.param('owner');
      const repoName = RepoService.normalizeRepo(c.req.param('repo'));
      const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
      if (!row) return c.json({ error: 'Not found' }, 404);
      const stub = getRepoStub(c.env, `${owner}/${repoName}`);
      return c.json(await stub.getBranches());
    });

    app.get('/user/repos/:owner/:repo/tree', async (c) => {
      const owner = c.req.param('owner');
      const repoName = RepoService.normalizeRepo(c.req.param('repo'));
      const url = new URL(c.req.url);
      const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
      if (!row) return c.json({ error: 'Not found' }, 404);
      const stub = getRepoStub(c.env, `${owner}/${repoName}`);
      return c.json(await stub.getTree({ ref: url.searchParams.get('ref') ?? undefined, path: url.searchParams.get('path') ?? undefined }));
    });

    app.get('/user/repos/:owner/:repo/blob', async (c) => {
      const owner = c.req.param('owner');
      const repoName = RepoService.normalizeRepo(c.req.param('repo'));
      const url = new URL(c.req.url);
      const filepath = url.searchParams.get('path') ?? '';
      const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
      if (!row) return c.json({ error: 'Not found' }, 404);
      const stub = getRepoStub(c.env, `${owner}/${repoName}`);
      return c.json(await stub.getBlob({ ref: url.searchParams.get('ref') ?? undefined, filepath }));
    });

    app.get('/user/repos/:owner/:repo/commits', async (c) => {
      const owner = c.req.param('owner');
      const repoName = RepoService.normalizeRepo(c.req.param('repo'));
      const url = new URL(c.req.url);
      const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
      if (!row) return c.json({ error: 'Not found' }, 404);
      const stub = getRepoStub(c.env, `${owner}/${repoName}`);
      const depth = url.searchParams.get('depth');
      return c.json(
        await stub.getCommits({ ref: url.searchParams.get('ref') ?? undefined, depth: depth ? Number(depth) : undefined }),
      );
    });

    app.get('/user/tokens', async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const svc = TokenServiceFactory.create({ DB: c.env.DB });
      const tokens = await svc.listTokens(email);
      return c.json({ tokens: tokens.map((t) => ({ tokenId: t.tokenId, name: t.name, expiresAt: t.expiresAt, lastUsedAt: t.lastUsedAt, createdAt: t.createdAt })) });
    });

    app.post('/user/tokens', async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const body = (await c.req.json().catch(() => ({}))) as { name?: string; expiresInDays?: number };
      if (!body.name) return c.json({ error: 'name is required' }, 400);
      try {
        const svc = TokenServiceFactory.create({ DB: c.env.DB });
        const created = await svc.createToken(email, body.name, body.expiresInDays);
        return c.json(created, 201);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed' }, 400);
      }
    });

    app.delete('/user/tokens/:id', async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const svc = TokenServiceFactory.create({ DB: c.env.DB });
      await svc.deleteToken(c.req.param('id'), email);
      return c.json({ ok: true });
    });

    app.get('/user/repos/:owner/:repo/issues', async (c) => {
      const owner = c.req.param('owner');
      const repoName = RepoService.normalizeRepo(c.req.param('repo'));
      const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
      if (!row) return c.json({ error: 'Not found' }, 404);
      const issues = await IssueServiceFactory.create({ DB: c.env.DB }).listByRepo(row.id, 50);
      return c.json({ issues });
    });

    app.post('/user/repos/:owner/:repo/issues', async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const owner = c.req.param('owner');
      const repoName = RepoService.normalizeRepo(c.req.param('repo'));
      const row = await requireVisibleRepo(c.env, owner, repoName, email);
      if (!row) return c.json({ error: 'Not found' }, 404);
      const body = (await c.req.json().catch(() => ({}))) as { title?: string; body?: string };
      if (!body.title) return c.json({ error: 'title is required' }, 400);
      const created = await IssueServiceFactory.create({ DB: c.env.DB }).createIssue({
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        title: body.title,
        body: body.body ?? null,
        creatorEmail: email,
      });
      return c.json(created, 201);
    });

    // SPA catch-all
    app.get('*', (c) => {
      if (!ConfigurationManager.spa.isServeFromWorker(c.env)) {
        return c.notFound();
      }
      const path: string = new URL(c.req.url).pathname;
      if (!path.startsWith('/user/')) {
        return c.notFound();
      }
      return c.html(SPA_HTML);
    });

    this.app = openapi;
  }

  protected async onRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return this.app.fetch(request, env, ctx);
  }

  protected onScheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const id = env.CRON_TASKS.idFromName('global');
    const stub = env.CRON_TASKS.get(id);
    ctx.waitUntil(
      stub
        .fetch(
          new Request('https://do/run', {
            method: 'POST',
            body: JSON.stringify({ cron: event.cron, scheduledTime: event.scheduledTime }),
          }),
        )
        .then(async (res: Response) => {
          if (!res.ok && res.status !== 202) {
            console.error('CronTasksWorker error', res.status, await res.text());
          }
        })
        .catch((error: unknown) => console.error('Cron invoke failed', error)),
    );
    return Promise.resolve();
  }
}

export { EdgeGitWorker };
