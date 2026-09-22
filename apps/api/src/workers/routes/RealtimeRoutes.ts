import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { RealtimeService } from '@edge-git/backend-services/realtime';
import { RepoFullName } from '@edge-git/shared/utils';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { isShard } from '@edge-git/shared/realtime';
import { repoNameSchema, usernameSchema } from '@edge-git/shared/validation';
import { getRealtimeStub } from '../doStubs';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

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
    if (realtimeDisabled(c.env)) return jsonError(c, 'Realtime is disabled', 503);
    const shard = new URL(c.req.url).searchParams.get('shard') ?? '';
    if (!isShard(shard)) return jsonError(c, 'Not found', 404);
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return jsonError(c, 'WebSocket upgrade required', 426);
    }
    try {
      // The shard DO serves `/ws`; rewrite the path but preserve the upgrade
      // headers by cloning the raw request.
      const url = new URL(c.req.url);
      url.pathname = '/ws';
      return await getRealtimeStub(c.env, shard).fetch(new Request(url.href, c.req.raw));
    } catch {
      return jsonError(c, 'Unavailable', 503);
    }
  });
}

// Ticket issuance behind `/user/*` Access auth (audited like other reads).
// Channel authorization happens in `RealtimeService`: private repos hide
// existence (404 without `read+`), inbox tags are only ever self-granted.
function registerRealtimeUserRoutes(app: RealtimeApp): void {
  app.post('/user/realtime/ticket', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    if (realtimeDisabled(c.env)) return jsonError(c, 'Realtime is disabled', 503);
    const { malformed, body } = await readJsonBody<{ owner?: unknown; repo?: unknown; channels?: unknown }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.owner !== 'string' || typeof body.repo !== 'string') {
      return jsonError(c, 'owner and repo are required', 400);
    }
    if (!usernameSchema.safeParse(body.owner.trim()).success) return jsonError(c, 'Invalid owner', 400);
    if (!repoNameSchema.safeParse(body.repo.trim()).success) return jsonError(c, 'Invalid repo', 400);
    if (body.channels !== undefined && !Array.isArray(body.channels)) {
      return jsonError(c, 'channels must be an array', 400);
    }
    let grant;
    try {
      grant = await getScope(c)
        .get(Tokens.RealtimeService)
        .authorizeRepoChannels({
          viewerEmail: email,
          owner: body.owner,
          repo: RepoFullName.normalizeRepo(body.repo),
          channels: body.channels,
        });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
    try {
      const issued = await getRealtimeStub(c.env, grant.shard).issueTicket({ shard: grant.shard, channels: grant.channels, viewer: email });
      if ('error' in issued) return jsonError(c, 'Unavailable', 503);
      return c.json({ shard: grant.shard, ticket: issued.ticket, expiresAt: issued.expiresAt, channels: grant.channels });
    } catch {
      return jsonError(c, 'Unavailable', 503);
    }
  });

  app.get('/user/realtime/inbox-ticket', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    if (realtimeDisabled(c.env)) return jsonError(c, 'Realtime is disabled', 503);
    try {
      const hash = await RealtimeService.inboxHashForEmail(email);
      const grant = getScope(c).get(Tokens.RealtimeService).inboxSubscription(hash);
      const issued = await getRealtimeStub(c.env, grant.shard).issueTicket({ shard: grant.shard, channels: grant.channels, viewer: email });
      if ('error' in issued) return jsonError(c, 'Unavailable', 503);
      return c.json({ shard: grant.shard, ticket: issued.ticket, expiresAt: issued.expiresAt, channels: grant.channels });
    } catch {
      return jsonError(c, 'Unavailable', 503);
    }
  });
}

export { registerRealtimePublicRoutes, registerRealtimeUserRoutes };
export type { RealtimeApp };
