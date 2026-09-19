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
    // Global 500 mask: never leak D1/DO internals on uncaught throws.
    // Route handlers must still use toSafeErrorMessage for caught errors.
    app.onError((error, c) => {
      console.error('Unhandled worker error', error instanceof Error ? error.message : error);
      return c.json({ Exception: { Type: 'InternalServerError', Message: 'Internal Server Error.' } }, 500);
    });

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
    // Anonymous credential-oracle guard: info/refs distinguishes 401/403 and
    // is cheap to poll, so cap it separately from pack POSTs.
    app.use('/:owner/:repo/info/refs', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'git-refs' }));
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
    // Repo creation + expensive search (x3 over-fetch + visibility filter)
    // are abuse-prone: cap creation tightly, search generously.
    app.use('/user/repos', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'repo-create' }));
    app.use('/search', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'search' }));
    // Public read-model enumeration guard: username/org profiles + public
    // repo metadata are cheap to scrape, so cap them separately.
    app.use('/users/*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'public-users' }));
    app.use('/repos/*', rateLimit({ windowMs: 60_000, max: 300, keyPrefix: 'public-repos' }));
    // Username rename is destructive (frees the old name immediately) —
    // cap it tightly like repo creation.
    app.use('/user/me/username', rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'username-rename' }));
    app.use('/user/orgs*', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'org-mutate' }));
    // Abuse-prone mutating surfaces: imports/mirrors fan out to third-party
    // hosts (SSRF amplification), webhook test/redeliver triggers outbound
    // fetch, file-write drives DO I/O. Per-isolate buckets; cron/DOs remain
    // the cross-isolate backstop.
    app.use('/user/repos/:owner/:repo/import*', rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'import' }));
    app.use('/user/repos/:owner/:repo/mirror*', rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'mirror' }));
    app.use('/user/repos/:owner/:repo/hooks*', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'webhook-mutate' }));
    app.use('/user/repos/:owner/:repo/contents*', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'file-write' }));
    // Comment/issue/pull write surfaces: per-repo buckets so one hot repo
    // cannot exhaust a global bucket for everyone else.
    app.use('/user/repos/:owner/:repo/issues*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'issues' }));
    app.use('/user/repos/:owner/:repo/pulls*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'pulls' }));
    app.use('/user/repos/:owner/:repo/comments*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'comments' }));
    // Previously uncapped list/mutating surfaces (D1/DO burn via enumeration):
    // audit readers, notifications/social, checks/keys, releases/assets,
    // collab surfaces, labels/milestones/threads/reviews, fork/sync, branches.
    app.use('/user/audit*', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'audit-read' }));
    app.use('/user/orgs/*/audit*', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'audit-org' }));
    app.use('/user/notifications*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'notifications' }));
    app.use('/user/repos/:owner/:repo/branches*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'branches' }));
    app.use('/user/repos/:owner/:repo/rules*', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'rules' }));
    app.use('/user/repos/:owner/:repo/collaborators*', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'collabs' }));
    app.use('/user/repos/:owner/:repo/checks*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'checks' }));
    app.use('/user/repos/:owner/:repo/keys*', rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'deploy-keys' }));
    app.use('/user/repos/:owner/:repo/releases*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'releases' }));
    app.use('/user/repos/:owner/:repo/projects*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'projects' }));
    app.use('/user/repos/:owner/:repo/discussions*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'discussions' }));
    app.use('/user/repos/:owner/:repo/wiki*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'wiki' }));
    app.use('/user/repos/:owner/:repo/snippets*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'snippets' }));
    app.use('/user/repos/:owner/:repo/labels*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'labels' }));
    app.use('/user/repos/:owner/:repo/milestones*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'milestones' }));
    app.use('/user/repos/:owner/:repo/threads*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'threads' }));
    app.use('/user/repos/:owner/:repo/reviews*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'reviews' }));
    app.use('/user/repos/:owner/:repo/fork*', rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'fork' }));
    app.use('/user/repos/:owner/:repo/star*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'social-mutate' }));
    app.use('/user/repos/:owner/:repo/watch*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'social-mutate' }));
    app.use('/user/stars*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'social-read' }));
    app.use('/user/watches*', rateLimit({ windowMs: 60_000, max: 120, keyPrefix: 'social-read' }));

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
