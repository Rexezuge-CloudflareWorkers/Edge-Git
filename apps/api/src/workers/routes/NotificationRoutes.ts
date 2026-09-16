import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';

type NotificationApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

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
    const email = c.get('AuthenticatedUserEmailAddress');
    const url = new URL(c.req.url);
    const unreadOnly = url.searchParams.get('unreadOnly') === '1' || url.searchParams.get('unreadOnly') === 'true';
    const limit = parsePositiveInt(url.searchParams.get('limit'), 30, 100);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const scope = createRequestScope(c.env);
    const [{ notifications, nextCursor }, unreadCount] = await Promise.all([
      scope.get(Tokens.NotificationService).listByUser(email, limit, cursor, unreadOnly),
      scope.get(Tokens.NotificationService).unreadCount(email),
    ]);
    return c.json({ notifications, nextCursor, unreadCount });
  });

  app.get('/user/notifications/unread-count', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const unreadCount = await createRequestScope(c.env).get(Tokens.NotificationService).unreadCount(email);
    return c.json({ unreadCount });
  });

  app.patch('/user/notifications/:id/read', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const ok = await createRequestScope(c.env).get(Tokens.NotificationService).markRead(c.req.param('id'), email);
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });

  app.post('/user/notifications/read-all', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const marked = await createRequestScope(c.env).get(Tokens.NotificationService).markAllRead(email);
    return c.json({ ok: true, marked });
  });
}

export { registerUserNotificationRoutes };
