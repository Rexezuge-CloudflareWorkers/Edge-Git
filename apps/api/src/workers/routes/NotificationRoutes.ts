import type { Hono } from 'hono';
import { jsonError, getScope } from './PublicViewerResolver';
import { Tokens } from '@edge-git/backend-services/composition';
import { usernameFor, usernameMap } from './IdentityPresenter';

type NotificationApp = Hono<{
  Bindings: Env;
  Variables: { AuthenticatedUserEmailAddress: string; AuthenticatedUserId?: string };
}>;

/**
 * The caller's notification owner.
 *
 * The account id is preferred so the inbox follows the account across an
 * address change; the address stays as the fallback for requests where the
 * account could not be resolved.
 */
function ownerOf(c: {
  get: (k: 'AuthenticatedUserId' | 'AuthenticatedUserEmailAddress') => string | undefined;
}): { userId: string | null; userEmail: string } {
  return { userId: c.get('AuthenticatedUserId') || null, userEmail: c.get('AuthenticatedUserEmailAddress') ?? '' };
}

function parsePositiveInt(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

// Personal notifications inbox behind /user/* Access auth. Rows are fanned
// out at event time only to users holding read+ (private repos never leak),
// so listing needs no per-row permission re-check.
function registerUserNotificationRoutes(app: NotificationApp): void {
  app.get('/user/notifications', async (c) => {
    const owner = ownerOf(c);
    const url = new URL(c.req.url);
    const unreadOnly = url.searchParams.get('unreadOnly') === '1' || url.searchParams.get('unreadOnly') === 'true';
    const limit = parsePositiveInt(url.searchParams.get('limit'), 30, 100);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const scope = getScope(c);
    const [{ notifications, nextCursor }, unreadCount] = await Promise.all([
      scope.get(Tokens.NotificationService).listByUser(owner, limit, cursor, unreadOnly),
      scope.get(Tokens.NotificationService).unreadCount(owner),
    ]);
    const map = await usernameMap(
      scope,
      notifications.map((n) => n.actor_email),
    );
    const presented = notifications.map(({ actor_email, ...rest }) => {
      const kept = { ...(rest as Record<string, unknown>) };
      delete kept['user_email'];
      return { ...kept, actor: usernameFor(map, actor_email) };
    });
    return c.json({ notifications: presented, nextCursor, unreadCount });
  });

  app.get('/user/notifications/unread-count', async (c) => {
    const unreadCount = await getScope(c).get(Tokens.NotificationService).unreadCount(ownerOf(c));
    return c.json({ unreadCount });
  });

  app.patch('/user/notifications/:id/read', async (c) => {
    const ok = await getScope(c).get(Tokens.NotificationService).markRead(c.req.param('id'), ownerOf(c));
    if (!ok) return jsonError(c, 'Not found', 404);
    return c.json({ ok: true });
  });

  app.post('/user/notifications/read-all', async (c) => {
    const marked = await getScope(c).get(Tokens.NotificationService).markAllRead(ownerOf(c));
    return c.json({ ok: true, marked });
  });
}

export { registerUserNotificationRoutes };
