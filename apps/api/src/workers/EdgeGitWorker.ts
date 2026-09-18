import { AbstractEntrypointWorker } from '@edge-git/backend-runtime/base';
import { fromHono } from 'chanfana';
import type { HonoOpenAPIRouterType } from 'chanfana';
import { Hono } from 'hono';
import { MiddlewareHandlers, rateLimit, securityHeaders } from '@/middleware';
import { scopeMiddleware } from '@/middleware/scopeMiddleware';
import { RESERVED_NAMESPACE_NAMES } from '@edge-git/shared/constants';
import { SPA_HTML } from '@/generated/spa-shell';
import { registerGitRoutes } from './routes/GitRoutes';
import { registerForkRoutes, registerUserForkRoutes } from './routes/ForkRoutes';
import { registerRepoRoutes, registerUserRepoRoutes, registerUserRepoReadModelRoutes } from './routes/RepoRoutes';
import { registerBranchRoutes } from './routes/BranchRoutes';
import { registerRuleRoutes } from './routes/RuleRoutes';
import { registerFileWriteRoutes } from './routes/FileWriteRoutes';
import { registerTokenRoutes } from './routes/TokenRoutes';
import { registerIssueRoutes, registerUserIssueRoutes } from './routes/IssueRoutes';
import {
  registerPullRoutes,
  registerUserPullMergeRoutes,
  registerUserPullRoutes,
  registerPullThreadRoutes,
  registerUserPullThreadRoutes,
} from './routes/PullRoutes';
import { registerRealtimePublicRoutes, registerRealtimeUserRoutes } from './routes/RealtimeRoutes';
import { registerUserProfileRoutes, registerUserSettingsRoutes } from './routes/UserRoutes';
import { registerOrgRoutes } from './routes/OrgRoutes';
import { registerTeamRoutes } from './routes/TeamRoutes';
import { registerAuditRoutes } from './routes/AuditRoutes';
import { registerSearchRoutes } from './routes/SearchRoutes';
import { registerUserNotificationRoutes } from './routes/NotificationRoutes';
import { registerSocialRoutes, registerUserSocialRoutes } from './routes/SocialRoutes';
import { registerWebhookRoutes } from './routes/WebhookRoutes';
import { registerCheckPublicRoutes, registerCheckUserRoutes } from './routes/CheckRoutes';
import { registerImportRoutes } from './routes/ImportRoutes';
import { registerMirrorRoutes } from './routes/MirrorRoutes';
import { registerDeployKeyRoutes } from './routes/DeployKeyRoutes';
import { registerSecurityRoutes } from './routes/SecurityRoutes';
import { registerReleaseAssetPublicRoutes, registerReleaseAssetUserRoutes } from './routes/ReleaseAssetRoutes';
import { registerReleasePublicRoutes, registerReleaseUserRoutes } from './routes/ReleaseRoutes';
import { registerProjectPublicRoutes, registerProjectUserRoutes } from './routes/ProjectRoutes';
import { registerDiscussionPublicRoutes, registerDiscussionUserRoutes } from './routes/DiscussionRoutes';
import { registerWikiPublicRoutes, registerWikiUserRoutes } from './routes/WikiRoutes';
import { registerSnippetPublicRoutes, registerSnippetUserRoutes } from './routes/SnippetRoutes';
import { registerCollabPublicRoutes, registerCollabUserRoutes } from './routes/CollabRoutes';

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

    // Security headers first so even the shell/health early routes carry
    // them; scope + guards follow for the remaining routes.
    app.use('*', securityHeaders());

    // User home (public shell; data is gated per-endpoint). /user stays the
    // Cloudflare Access entry point and redirects into the authenticated app.
    app.get('/', (c) => {
      return c.html(SPA_HTML);
    });
    app.get('/user', (c) => c.redirect('/user/' + new URL(c.req.url).search));
    app.get('/health', (c) => c.json({ ok: true, service: 'edge-git' }));

    // Single-scope-per-request composition root (Otter pattern). Installed
    // first so every handler resolves via `getScope(c)` instead of minting
    // N containers per request.
    app.use('*', scopeMiddleware);
    // Minimal abuse guards (per-isolate token buckets; cron/DOs are the
    // cross-isolate backstop). Generous limits so legitimate use never 429s.
    app.use('/:owner/:repo/git-upload-pack', rateLimit({ windowMs: 60_000, max: 300, keyPrefix: 'git-fetch' }));
    app.use('/:owner/:repo/git-receive-pack', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'git-push' }));
    // Immediate webhook dispatch runs after mutating handlers via
    // `waitUntil` (cron retries the rest). Registered before the routes so
    // Hono executes the middleware first.
    app.use('/:owner/:repo/git-receive-pack', MiddlewareHandlers.webhookFlush());
    // Audit-everything: records pushes (email resolved in-handler via
    // `gitAuthForRepo`, missing → `unknown`). Fetches stay unaudited —
    // anonymous clone volume would explode D1 writes.
    app.use('/:owner/:repo/git-receive-pack', MiddlewareHandlers.activityAudit());

    registerGitRoutes(app);
    registerRealtimePublicRoutes(app);
    registerRepoRoutes(app);
    registerForkRoutes(app);
    registerIssueRoutes(app);
    registerPullRoutes(app);
    registerPullThreadRoutes(app);
    registerUserProfileRoutes(app);
    registerSearchRoutes(app);
    registerSocialRoutes(app);
    registerCheckPublicRoutes(app);
    registerReleasePublicRoutes(app);
    registerReleaseAssetPublicRoutes(app);
    registerProjectPublicRoutes(app);
    registerDiscussionPublicRoutes(app);
    registerWikiPublicRoutes(app);
    registerSnippetPublicRoutes(app);
    registerCollabPublicRoutes(app);

    // Protected UI/API surface
    // Audit-everything runs BEFORE authentication so denied requests are
    // captured too (email read in `finally`, missing → `unknown`).
    app.use('/user/*', MiddlewareHandlers.activityAudit());
    app.use('/user/*', MiddlewareHandlers.userAuthentication());
    app.use('/user/*', MiddlewareHandlers.webhookFlush());
    app.use('/user/tokens*', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'tokens' }));
    app.use('/user/realtime/*', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'realtime' }));
    // Abuse-prone mutating surfaces: imports/mirrors fan out to third-party
    // hosts (SSRF amplification), webhook test/redeliver triggers outbound
    // fetch, file-write drives DO I/O. Per-isolate buckets; cron/DOs remain
    // the cross-isolate backstop.
    app.use('/user/repos/:owner/:repo/import*', rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'import' }));
    app.use('/user/repos/:owner/:repo/mirror*', rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'mirror' }));
    app.use('/user/repos/:owner/:repo/hooks*', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'webhook-mutate' }));
    app.use('/user/repos/:owner/:repo/contents*', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'file-write' }));

    registerUserRepoRoutes(app);
    registerUserSettingsRoutes(app);
    registerOrgRoutes(app);
    registerTeamRoutes(app);
    registerAuditRoutes(app);

    const openapi: AppRouter = fromHono(app, { docs_url: '/docs' });

    registerUserRepoReadModelRoutes(app);
    registerBranchRoutes(app);
    registerRuleRoutes(app);
    registerFileWriteRoutes(app);
    registerUserForkRoutes(app);
    registerTokenRoutes(app);
    registerUserIssueRoutes(app);
    registerUserPullRoutes(app);
    registerUserPullMergeRoutes(app);
    registerUserPullThreadRoutes(app);
    registerUserSocialRoutes(app);
    registerUserNotificationRoutes(app);
    registerRealtimeUserRoutes(app);
    registerCollabUserRoutes(app);
    registerProjectUserRoutes(app);
    registerDiscussionUserRoutes(app);
    registerWikiUserRoutes(app);
    registerSnippetUserRoutes(app);
    registerReleaseUserRoutes(app);
    registerReleaseAssetUserRoutes(app);
    registerWebhookRoutes(app);
    registerCheckUserRoutes(app);
    registerImportRoutes(app);
    registerMirrorRoutes(app);
    registerDeployKeyRoutes(app);
    registerSecurityRoutes(app);

    // SPA catch-all — public shell for user home (/), profile home
    // (/:username, GitHub-style), repo home (/:owner/:repo), and the legacy
    // authenticated /user/* app.
    // Git Smart HTTP paths never reach here: they match exact routes above.
    app.get('*', (c) => {
      const path: string = new URL(c.req.url).pathname;
      if (
        path === '/' ||
        path === '/settings' ||
        path === '/new' ||
        path === '/search' ||
        path === '/notifications' ||
        path === '/snippets' ||
        path.startsWith('/user/') ||
        path.startsWith('/snippets/')
      ) {
        return c.html(SPA_HTML);
      }
      if (/^\/[^/]+\/?$/.test(path)) {
        // Single-segment profile shell — never shadow reserved API/UI roots.
        const segment = path.replace(/^\//, '').replace(/\/$/, '').toLowerCase();
        if (!RESERVED_NAMESPACE_NAMES.has(segment)) return c.html(SPA_HTML);
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
      if (/^\/[^/]+\/[^/]+\/commit\/[^/]+\/?$/.test(path)) {
        return c.html(SPA_HTML);
      }
      if (/^\/[^/]+\/[^/]+\/compare\/?$/.test(path)) {
        return c.html(SPA_HTML);
      }
      if (/^\/[^/]+\/[^/]+\/commits\/?$/.test(path)) {
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
        .then((res: Response) => {
          if (!res.ok && res.status !== 202) {
            console.error('CronTasksWorker error', res.status);
          }
        })
        .catch((error: unknown) => console.error('Cron invoke failed', error)),
    );
    return Promise.resolve();
  }
}

export { EdgeGitWorker };
