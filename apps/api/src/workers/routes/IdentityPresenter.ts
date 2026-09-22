import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { GHOST_USERNAME } from '@edge-git/backend-services/identity';
import { isValidEmailFormat } from '@edge-git/shared/utils';

type Scope = ReturnType<typeof createRequestScope>;

async function usernameMap(scope: Scope, emails: Array<string | null | undefined>): Promise<Map<string, string>> {
  const cleaned = emails.filter((e): e is string => typeof e === 'string' && e.length > 0);
  if (cleaned.length === 0) return new Map();
  // Fail closed on outage: propagate instead of returning an empty map that
  // would misattribute every author to `ghost`. Callers surface 500 via
  // BaseRoute so an identity outage never rewrites history attribution.
  return scope.get(Tokens.IdentityResolver).resolveUsernames(cleaned);
}

function usernameFor(map: Map<string, string>, email: string | null | undefined): string {
  if (!email) return GHOST_USERNAME;
  return map.get(email.trim().toLowerCase()) ?? GHOST_USERNAME;
}

async function resolveFilterEmail(scope: Scope, input: string | undefined): Promise<string | undefined> {
  if (!input) return undefined;
  const raw = input.trim();
  if (!raw || raw.length > 254) return undefined;
  if (raw.includes('@')) {
    const normalized = raw.toLowerCase();
    if (!isValidEmailFormat(normalized)) return '__unknown_user__';
    return normalized;
  }
  try {
    const email = await scope.get(Tokens.IdentityResolver).resolveEmail(raw);
    // Unknown username filters to a sentinel that matches nothing instead of
    // falling back to full-table scan or leaking existence.
    return email ?? '__unknown_user__';
  } catch {
    return '__unknown_user__';
  }
}

function collectEmails(rows: Array<Record<string, unknown> | object>): string[] {
  const out: string[] = [];
  const scan = (row: Record<string, unknown>): void => {
    for (const key of [
      'creator_email',
      'author_email',
      'actor_email',
      'user_email',
      'merged_by',
      'resolved_by',
      'dismissed_by',
      'granted_by',
      'created_by',
      'creatorEmail',
      'authorEmail',
      'actorEmail',
      'ownerEmail',
      'createdBy',
    ]) {
      const v = row[key];
      if (typeof v === 'string' && v) out.push(v);
    }
    const nestedKeys = ['comments', 'reviews', 'threads', 'discussions', 'replies', 'children'] as const;
    for (const key of nestedKeys) {
      const nested = row[key];
      if (Array.isArray(nested)) {
        for (const n of nested) {
          if (n && typeof n === 'object') scan(n as Record<string, unknown>);
        }
      }
    }
  };
  for (const row of rows) {
    if (row && typeof row === 'object') scan(row as Record<string, unknown>);
  }
  return out;
}

// Email is the stable store key; public JSON exposes only current usernames.
// Drops raw `*_email` fields and adds GitHub-style `creator/author/actor`
// username fields. `createdBy` keeps its neutral key with a username value.
function presentOne(row: Record<string, unknown>, map: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  if (typeof out['creator_email'] === 'string' && out['creator_email']) {
    out['creator'] = usernameFor(map, out['creator_email']);
  }
  delete out['creator_email'];
  if (typeof out['author_email'] === 'string' && out['author_email']) {
    out['author'] = usernameFor(map, out['author_email']);
  }
  delete out['author_email'];
  if (typeof out['actor_email'] === 'string' && out['actor_email']) {
    out['actor'] = usernameFor(map, out['actor_email']);
  }
  delete out['actor_email'];
  if (typeof out['creatorEmail'] === 'string' && out['creatorEmail']) {
    out['creator'] = usernameFor(map, out['creatorEmail']);
    delete out['creatorEmail'];
  }
  if (typeof out['authorEmail'] === 'string' && out['authorEmail']) {
    out['author'] = usernameFor(map, out['authorEmail']);
    delete out['authorEmail'];
  }
  if (typeof out['actorEmail'] === 'string' && out['actorEmail']) {
    out['actor'] = usernameFor(map, out['actorEmail']);
    delete out['actorEmail'];
  }
  if (typeof out['ownerEmail'] === 'string' && out['ownerEmail']) {
    out['owner'] = usernameFor(map, out['ownerEmail']);
    delete out['ownerEmail'];
  }
  // Nullable attribution stays null when unset, username otherwise.
  if ('merged_by' in out) {
    const v = out['merged_by'];
    out['mergedBy'] = typeof v === 'string' && v ? usernameFor(map, v) : null;
    delete out['merged_by'];
  }
  if ('resolved_by' in out) {
    const v = out['resolved_by'];
    out['resolvedBy'] = typeof v === 'string' && v ? usernameFor(map, v) : null;
    delete out['resolved_by'];
  }
  if ('dismissed_by' in out) {
    const v = out['dismissed_by'];
    out['dismissedBy'] = typeof v === 'string' && v ? usernameFor(map, v) : null;
    delete out['dismissed_by'];
  }
  if ('created_by' in out) {
    const v = out['created_by'];
    out['createdBy'] = typeof v === 'string' && v ? usernameFor(map, v) : null;
    delete out['created_by'];
  }
  if (typeof out['createdBy'] === 'string' && out['createdBy'].includes('@')) {
    out['createdBy'] = usernameFor(map, out['createdBy']);
  }
  // Preserve attribution: map to camelCase username instead of dropping.
  if ('granted_by' in out) {
    const v = out['granted_by'];
    out['grantedBy'] = typeof v === 'string' && v ? usernameFor(map, v) : null;
    delete out['granted_by'];
  }
  if ('user_email' in out) {
    // Member/collaborator lists map to `username`. Rows without a `role`
    // (e.g. reviewer/triage lists) still expose `username` so callers do not
    // need per-route workarounds; notification recipient rows keep the
    // username as well since the viewer already knows the recipient set.
    const v = out['user_email'];
    if (typeof v === 'string' && v) {
      out['username'] = usernameFor(map, v);
    }
    delete out['user_email'];
  }
  // Nested thread/discussion/review collections carry their own `*_email`
  // fields. Recurse into every known container so raw emails never leak in
  // nested JSON (previously only `comments` was redacted).
  for (const key of ['comments', 'reviews', 'threads', 'discussions', 'replies', 'children'] as const) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as Array<unknown>).map((n) =>
        n && typeof n === 'object' ? presentOne({ ...(n as Record<string, unknown>) }, map) : n,
      );
    }
  }
  return out;
}

async function presentMany(scope: Scope, rows: Array<unknown>): Promise<Array<Record<string, unknown>>> {
  if (rows.length === 0) return [];
  const map = await usernameMap(scope, collectEmails(rows as Array<Record<string, unknown>>));
  return (rows as Array<Record<string, unknown>>).map((r) => presentOne({ ...r }, map));
}

async function presentSingle(scope: Scope, row: unknown): Promise<Record<string, unknown>> {
  const [one] = await presentMany(scope, [row]);
  return one ?? presentOne({ ...(row as Record<string, unknown>) }, new Map());
}

export { usernameMap, usernameFor, resolveFilterEmail, collectEmails, presentOne, presentMany, presentSingle };

export { GHOST_USERNAME } from '@edge-git/backend-services/identity';
