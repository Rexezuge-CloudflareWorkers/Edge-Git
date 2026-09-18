import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RealtimeService } from '@edge-git/backend-services/realtime';
import { RepoService } from '@edge-git/backend-services/repo';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { isShard } from '@edge-git/shared/realtime';
import { getRealtimeStub } from '../realtimeStub';
import { toServiceStatus } from './PublicViewerResolver';

type RealtimeApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function realtimeDisabled(env: Env): boolean {
  try {
    return !ConfigurationManager.realtime.isEnabled(env);
  } catch {
    return true;
  }
}

// Public upgrade: the ticket IS the auth (single-use, 30s TTL), so no Access
// session is needed here. The handler stays under the 10ms Worker CPU budget
// by forwarding to the shard DO, which redeems the ticket and owns the
// socket. Failures return plain HTTP errors — the SPA falls back to polling.
function registerRealtimePublicRoutes(app: RealtimeApp): void {
  app.get('/realtime/ws', async (c) => {
    if (realtimeDisabled(c.env)) return c.json({ error: 'Realtime is disabled' }, 503);
    const shard = new URL(c.req.url).searchParams.get('shard') ?? '';
    if (!isShard(shard)) return c.json({ error: 'Not found' }, 404);
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.json({ error: 'WebSocket upgrade required' }, 426);
    }
    try {
      // The shard DO serves `/ws`; rewrite the path but preserve the upgrade
      // headers by cloning the raw request.
      const url = new URL(c.req.url);
      url.pathname = '/ws';
      return await getRealtimeStub(c.env, shard).fetch(new Request(url.href, c.req.raw));
    } catch {
      return c.json({ error: 'Unavailable' }, 503);
    }
  });
}

// Ticket issuance behind `/user/*` Access auth (audited like other reads).
// Channel authorization happens in `RealtimeService`: private repos hide
// existence (404 without `read+`), inbox tags are only ever self-granted.
function registerRealtimeUserRoutes(app: RealtimeApp): void {
  app.post('/user/realtime/ticket', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    if (realtimeDisabled(c.env)) return c.json({ error: 'Realtime is disabled' }, 503);
    const body = (await c.req.json().catch(() => ({}))) as { owner?: unknown; repo?: unknown; channels?: unknown };
    if (typeof body.owner !== 'string' || typeof body.repo !== 'string') {
      return c.json({ error: 'owner and repo are required' }, 400);
    }
    let grant;
    try {
      grant = await createRequestScope(c.env)
        .get(Tokens.RealtimeService)
        .authorizeRepoChannels({
          viewerEmail: email,
          owner: body.owner,
          repo: RepoService.normalizeRepo(body.repo),
          channels: body.channels,
        });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
    try {
      const issued = await getRealtimeStub(c.env, grant.shard).issueTicket({ shard: grant.shard, channels: grant.channels, viewer: email });
      if ('error' in issued) return c.json({ error: 'Unavailable' }, 503);
      return c.json({ shard: grant.shard, ticket: issued.ticket, expiresAt: issued.expiresAt, channels: grant.channels });
    } catch {
      return c.json({ error: 'Unavailable' }, 503);
    }
  });

  app.get('/user/realtime/inbox-ticket', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    if (realtimeDisabled(c.env)) return c.json({ error: 'Realtime is disabled' }, 503);
    try {
      const hash = await RealtimeService.inboxHashForEmail(email);
      const grant = createRequestScope(c.env).get(Tokens.RealtimeService).inboxSubscription(hash);
      const issued = await getRealtimeStub(c.env, grant.shard).issueTicket({ shard: grant.shard, channels: grant.channels, viewer: email });
      if ('error' in issued) return c.json({ error: 'Unavailable' }, 503);
      return c.json({ shard: grant.shard, ticket: issued.ticket, expiresAt: issued.expiresAt, channels: grant.channels });
    } catch {
      return c.json({ error: 'Unavailable' }, 503);
    }
  });
}

export { registerRealtimePublicRoutes, registerRealtimeUserRoutes };
export type { RealtimeApp };
