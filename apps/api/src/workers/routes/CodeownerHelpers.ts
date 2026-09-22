import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { matchCodeowners, parseCodeowners } from '@edge-git/backend-services/collab';
import { normalizeCodeownerHandle, parseCodeownerTeam } from '@edge-git/backend-services/collab';
import { getRepoStub } from '../doStubs';

interface CodeownerRule {
  pattern: string;
  owners: string[];
}

/**
 * Minimal blob view returned by DO `getBlob` (avoids inline casts).
 */
interface BlobLike {
  contentBase64?: string;
  isBinary?: boolean;
}

const CODEOWNER_CANDIDATES = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];
const MAX_RULE_CONTENT_BYTES = 20_000;
const MAX_DIFF_PATHS = 50;
const MAX_SUGGESTED_OWNERS = 20;
const MAX_RESOLVED_OWNERS = 10;

function decodeBlobContent(blob: BlobLike | null): string | null {
  if (!blob?.contentBase64 || blob.isBinary) return null;
  try {
    const binary = atob(blob.contentBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0;
    const text = new TextDecoder().decode(bytes).slice(0, MAX_RULE_CONTENT_BYTES);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

async function readCodeownerRules(env: Env, fullName: string, baseBranch: string): Promise<CodeownerRule[]> {
  const stub = getRepoStub(env, fullName);
  // List-then-read: a direct `getBlob` miss leaves a dangling isomorphic-git
  // rejection that workerd surfaces as unhandled (it fails
  // `vitest-pool-workers` runs and spams production logs). Membership checks
  // against tree listings only ever read objects known to exist. Stubs
  // without `getTree` (unit-test fakes) fall back to direct probing.
  if (typeof (stub as { getTree?: unknown }).getTree !== 'function') {
    for (const candidate of CODEOWNER_CANDIDATES) {
      try {
        const blob = (await stub.getBlob({ ref: baseBranch, filepath: candidate })) as BlobLike | null;
        const content = decodeBlobContent(blob);
        if (content) return parseCodeowners(content);
      } catch {
        continue;
      }
    }
    return [];
  }
  let rootNames: Set<string>;
  try {
    const root = (await stub.getTree({ ref: baseBranch, withLastCommit: false })) as Array<{ path: string }> | null;
    rootNames = new Set((root ?? []).map((e) => e.path));
  } catch {
    return [];
  }
  for (const candidate of CODEOWNER_CANDIDATES) {
    try {
      const slash = candidate.indexOf('/');
      if (slash === -1) {
        if (!rootNames.has(candidate)) continue;
      } else {
        const dir = candidate.slice(0, slash);
        if (!rootNames.has(dir)) continue;
        const leaf = candidate.slice(slash + 1);
        const sub = (await stub.getTree({ ref: baseBranch, path: dir, withLastCommit: false })) as Array<{
          path: string;
        }> | null;
        if ((sub ?? []).every((e) => e.path !== leaf)) continue;
      }
      const blob = (await stub.getBlob({ ref: baseBranch, filepath: candidate })) as BlobLike | null;
      const content = decodeBlobContent(blob);
      if (content) return parseCodeowners(content);
    } catch {
      continue;
    }
  }
  return [];
}

async function suggestCodeownerHandles(
  env: Env,
  fullName: string,
  input: { baseBranch: string; baseOid: string | null; headOid: string | null },
): Promise<{ owners: string[]; rules: number }> {
  const rules = await readCodeownerRules(env, fullName, input.baseBranch).catch(() => []);
  if (rules.length === 0 || !input.headOid) return { owners: [], rules: 0 };
  try {
    const stub = getRepoStub(env, fullName);
    const diff = (await stub.getPullDiff({ baseOid: input.baseOid ?? null, headOid: input.headOid })) as {
      changes?: Array<{ path: string }>;
    } | null;
    const paths = (diff?.changes ?? []).slice(0, MAX_DIFF_PATHS).map((ch) => ch.path);
    const found = new Set<string>();
    for (const p of paths) for (const o of matchCodeowners(rules, p)) found.add(o);
    if (found.size > 0) return { owners: [...found].slice(0, MAX_SUGGESTED_OWNERS), rules: rules.length };
  } catch {
    // fall through to rule-level fallback below
  }
  const fallback = [...new Set(rules.flatMap((r) => r.owners))].slice(0, MAX_SUGGESTED_OWNERS);
  return { owners: fallback, rules: rules.length };
}

/**
 * Pure email accumulator (Specification): lowercase, exclude-self, dedupe,
 * and cap-aware. Shared by team expansion and raw-email passthrough so both
 * paths enforce the same invite rules.
 */
function appendUniqueEmails(into: string[], candidates: readonly string[], excludeLower: string, cap: number): string[] {
  for (const candidate of candidates) {
    if (into.length >= cap) break;
    const lower = candidate.toLowerCase();
    if (!lower || lower === excludeLower || into.includes(lower)) continue;
    into.push(lower);
  }
  return into;
}

async function collectTeamMemberEmails(
  env: Env,
  team: { org: string; team: string },
  excludeEmail: string,
  remaining: number,
): Promise<string[]> {
  if (remaining <= 0) return [];
  try {
    const emails = await createRequestScope(env).get(Tokens.TeamService).listMemberEmails(team.org, team.team);
    return appendUniqueEmails([], emails, excludeEmail, remaining);
  } catch {
    // Unresolvable team — skip like before.
    return [];
  }
}

async function resolveCodeownerEmails(env: Env, handles: readonly string[], excludeEmail?: string): Promise<string[]> {
  const excluded = (excludeEmail ?? '').toLowerCase();
  const scope = createRequestScope(env);
  const out: string[] = [];
  for (const handle of handles) {
    if (out.length >= MAX_RESOLVED_OWNERS) break;
    // `org/team` tokens expand to team member emails (best-effort).
    const team = parseCodeownerTeam(handle);
    if (team) {
      const collected = await collectTeamMemberEmails(env, team, excluded, MAX_RESOLVED_OWNERS - out.length);
      out.push(...collected.filter((email) => !out.includes(email)));
      continue;
    }
    const normalized = normalizeCodeownerHandle(handle);
    if (!normalized) {
      // Raw emails pass through without a directory lookup.
      const email = handle.trim().toLowerCase();
      if (email !== excluded && !email.includes(' ') && email.includes('@') && !out.includes(email)) out.push(email);
      continue;
    }
    try {
      const resolved = await scope.get(Tokens.OrganizationService).resolveEmail(normalized);
      const email = resolved.toLowerCase();
      if (email && email !== excluded && !out.includes(email)) out.push(email);
    } catch {
      continue;
    }
  }
  return out;
}

export { suggestCodeownerHandles, resolveCodeownerEmails, readCodeownerRules, decodeBlobContent, appendUniqueEmails };
export type { BlobLike };
