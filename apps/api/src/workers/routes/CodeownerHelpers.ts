import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { matchCodeowners, parseCodeowners } from '@edge-git/backend-services/collab';
import { normalizeCodeownerHandle, parseCodeownerTeam } from '@edge-git/backend-services/collab';
import { getRepoStub } from '../repoStub';

interface CodeownerRule {
  pattern: string;
  owners: string[];
}

const CODEOWNER_CANDIDATES = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];
const MAX_RULE_CONTENT_BYTES = 20_000;
const MAX_DIFF_PATHS = 50;
const MAX_SUGGESTED_OWNERS = 20;
const MAX_RESOLVED_OWNERS = 10;

function decodeBlobContent(blob: { contentBase64?: string; isBinary?: boolean } | null): string | null {
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
  for (const candidate of CODEOWNER_CANDIDATES) {
    try {
      const blob = (await stub.getBlob({ ref: baseBranch, filepath: candidate })) as {
        contentBase64?: string;
        isBinary?: boolean;
      } | null;
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

async function collectTeamMemberEmails(
  env: Env,
  team: { org: string; team: string },
  excludeEmail: string,
  remaining: number,
): Promise<string[]> {
  if (remaining <= 0) return [];
  try {
    const emails = await createRequestScope(env).get(Tokens.TeamService).listMemberEmails(team.org, team.team);
    const collected: string[] = [];
    for (const email of emails) {
      const lower = email.toLowerCase();
      if (lower && lower !== excludeEmail && !collected.includes(lower)) collected.push(lower);
    }
    return collected.slice(0, remaining);
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

export { suggestCodeownerHandles, resolveCodeownerEmails, readCodeownerRules };
