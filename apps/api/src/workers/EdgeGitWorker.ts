import { AbstractEntrypointWorker } from '@edge-git/backend-runtime/base';
import { fromHono } from 'chanfana';
import type { HonoOpenAPIRouterType } from 'chanfana';
import { Hono } from 'hono';
import { MiddlewareHandlers } from '@/middleware';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { SPA_HTML } from '@/generated/spa-shell';
import { registerGitRoutes } from './routes/GitRoutes';
import { registerRepoRoutes, registerUserRepoRoutes, registerUserRepoReadModelRoutes } from './routes/RepoRoutes';
import { registerTokenRoutes } from './routes/TokenRoutes';
import { registerIssueRoutes, registerUserIssueRoutes } from './routes/IssueRoutes';
import { registerPullRoutes, registerUserPullRoutes } from './routes/PullRoutes';
import { registerUserProfileRoutes, registerUserSettingsRoutes } from './routes/UserRoutes';
import { registerOrgRoutes } from './routes/OrgRoutes';

type AppRouter = HonoOpenAPIRouterType<{
  Bindings: Env;
  Variables: { AuthenticatedUserEmailAddress: string };
}>;

class EdgeGitWorker extends AbstractEntrypointWorker {
  protected readonly app: AppRouter;

  constructor() {
    super();

    const app = new Hono<{
      Bindings: Env;
      Variables: { AuthenticatedUserEmailAddress: string };
    }>();

    // User home (public shell; data is gated per-endpoint). /user stays the
    // Cloudflare Access entry point and redirects into the authenticated app.
    app.get('/', (c) => {
      if (!ConfigurationManager.spa.isServeFromWorker(c.env)) {
        return c.notFound();
      }
      return c.html(SPA_HTML);
    });
    app.get('/user', (c) => c.redirect('/user/' + new URL(c.req.url).search));
    app.get('/health', (c) => c.json({ ok: true, service: 'edge-git' }));

    registerGitRoutes(app);
    registerRepoRoutes(app);
    registerIssueRoutes(app);
    registerPullRoutes(app);
    registerUserProfileRoutes(app);

    // Protected UI/API surface
    app.use('/user/*', MiddlewareHandlers.userAuthentication());

    registerUserRepoRoutes(app);
    registerUserSettingsRoutes(app);
    registerOrgRoutes(app);

    const openapi: AppRouter = fromHono(app, { docs_url: '/docs' });

    registerUserRepoReadModelRoutes(app);
    registerTokenRoutes(app);
    registerUserIssueRoutes(app);
    registerUserPullRoutes(app);

    // SPA catch-all — public shell for user home (/), profile home
    // (/:username, GitHub-style), repo home (/:owner/:repo), and the legacy
    // authenticated /user/* app.
    // Git Smart HTTP paths never reach here: they match exact routes above.
    app.get('*', (c) => {
      if (!ConfigurationManager.spa.isServeFromWorker(c.env)) {
        return c.notFound();
      }
      const path: string = new URL(c.req.url).pathname;
      if (path === '/' || path === '/settings' || path === '/new' || path.startsWith('/user/')) {
        return c.html(SPA_HTML);
      }
      if (/^\/[^/]+\/?$/.test(path)) {
        // Single-segment profile shell — never shadow reserved API/UI roots.
        const segment = path.replace(/^\//, '').replace(/\/$/, '').toLowerCase();
        const reserved = new Set(['health', 'docs', 'repos', 'users', 'user', 'settings', 'new']);
        if (!reserved.has(segment)) return c.html(SPA_HTML);
        return c.notFound();
      }
      if (/^\/[^/]+\/[^/]+\/?$/.test(path)) {
        return c.html(SPA_HTML);
      }
      if (/^\/[^/]+\/[^/]+\/issues\/[^/]+\/?$/.test(path)) {
        return c.html(SPA_HTML);
      }
      if (/^\/[^/]+\/[^/]+\/pulls\/[^/]+\/?$/.test(path)) {
        return c.html(SPA_HTML);
      }
      return c.notFound();
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
