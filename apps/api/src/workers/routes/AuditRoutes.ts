import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { BadRequestError } from '@edge-git/backend-errors';
import { clampAuditLimit, truncateAuditFilter } from '@edge-git/shared/validation';
import { jsonError, toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';

type AuditApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function isValidAuditCursor(cursor: string): boolean {
  try {
    JSON.parse(atob(cursor));
    return true;
  } catch {
    return false;
  }
}

function parseAuditQuery(url: string): {
  userEmail?: string;
  action?: string;
  repo?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  cursor?: string;
} {
  const params = new URL(url).searchParams;
  const out: { userEmail?: string; action?: string; repo?: string; startTime?: number; endTime?: number; limit?: number; cursor?: string } =
    {};
  const userEmail = params.get('userEmail') ?? params.get('user_email');
  const action = params.get('action');
  const repo = params.get('repo');
  const cursor = params.get('cursor');
  if (truncateAuditFilter(userEmail ?? undefined)) out.userEmail = truncateAuditFilter(userEmail ?? undefined);
  if (truncateAuditFilter(action ?? undefined)) out.action = truncateAuditFilter(action ?? undefined);
  if (truncateAuditFilter(repo ?? undefined)) out.repo = truncateAuditFilter(repo ?? undefined);
  if (cursor) {
    const sliced = cursor.slice(0, 500);
    // Tampered cursors fail closed (400 in the DAO via decodeCursorOrThrow),
    // never silently restart at page 1 — but drop obvious garbage early so
    // oversized/invalid cursors cannot fan out into D1.
    if (!isValidAuditCursor(sliced)) throw new BadRequestError('Invalid cursor');
    out.cursor = sliced;
  }
  // NOTE: `Number(null)` is 0, so missing params must stay unset — otherwise
  // every unfiltered query would silently gain `timestamp <= 0` and match
  // nothing (fail-closed the wrong way: empty audit trails).
  const startRaw = params.get('startTime');
  const endRaw = params.get('endTime');
  const limitRaw = params.get('limit');
  const startTime = startRaw === null ? NaN : Number(startRaw);
  const endTime = endRaw === null ? NaN : Number(endRaw);
  const limit = limitRaw === null ? NaN : Number(limitRaw);
  if (Number.isSafeInteger(startTime)) out.startTime = startTime;
  if (Number.isSafeInteger(endTime)) out.endTime = endTime;
  const clamped = clampAuditLimit(Number.isSafeInteger(limit) ? limit : undefined);
  if (clamped !== undefined) out.limit = clamped;
  return out;
}

function logJson(
  rows: Array<{
    log_id: string;
    timestamp: number;
    user_email: string;
    action: string;
    resource: string | null;
    method: string;
    path: string;
    status_code: number;
    detail: string | null;
    ip_address: string | null;
    user_agent: string | null;
  }>,
): unknown {
  return rows.map((r) => ({
    id: r.log_id,
    timestamp: r.timestamp,
    userEmail: r.user_email,
    action: r.action,
    resource: r.resource,
    method: r.method,
    path: r.path,
    statusCode: r.status_code,
    detail: r.detail,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
  }));
}

// Audit readers (AccessBridge `GET /user/admin/audit-logs` pattern, scoped
// per-org because Edge-Git has no superadmin tier): org owners read their
// org trail, everyone reads their own actions at `/user/audit`.
function registerAuditRoutes(app: AuditApp): void {
  app.get('/user/orgs/:org/audit', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const query = parseAuditQuery(c.req.url);
    try {
      const scope = createRequestScope(c.env);
      let repoId: string | undefined;
      if (query.repo) {
        const name = query.repo.includes('/') ? (query.repo.split('/').at(-1) ?? query.repo) : query.repo;
        const repo = await scope.get(Tokens.RepoService).getByOwnerAndName(c.req.param('org'), RepoFullName.normalizeRepo(name));
        if (!repo) return jsonError(c, 'Repository not found', 404);
        repoId = repo.id;
      }
      const { logs, nextCursor } = await scope
        .get(Tokens.AuditService)
        .queryByOrg(
          c.req.param('org'),
          email,
          { userEmail: query.userEmail, action: query.action, repoId, startTime: query.startTime, endTime: query.endTime },
          query.limit,
          query.cursor,
        );
      return c.json({ logs: logJson(logs), nextCursor });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.get('/user/audit', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const query = parseAuditQuery(c.req.url);
    try {
      const { logs, nextCursor } = await createRequestScope(c.env)
        .get(Tokens.AuditService)
        .queryMine(email, { action: query.action, startTime: query.startTime, endTime: query.endTime }, query.limit, query.cursor);
      return c.json({ logs: logJson(logs), nextCursor });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });
}

export { registerAuditRoutes, parseAuditQuery };
