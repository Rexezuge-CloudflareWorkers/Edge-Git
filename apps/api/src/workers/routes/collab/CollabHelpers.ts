import type { Hono } from 'hono';
import { requireVisibleRepo } from '../PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { parsePositiveInt } from '@edge-git/shared/validation';

type CollabApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parseNumber(raw: string | undefined): number | null {
  return parsePositiveInt(raw ?? null);
}

async function needWrite(env: Env, owner: string, repo: string, email: string): Promise<boolean> {
  try {
    await createRequestScope(env).get(Tokens.RepoService).requireRole(owner, repo, email, 'write');
    return true;
  } catch {
    return false;
  }
}

async function needAdmin(env: Env, owner: string, repo: string, email: string): Promise<boolean> {
  try {
    await createRequestScope(env).get(Tokens.RepoService).requireRole(owner, repo, email, 'admin');
    return true;
  } catch {
    return false;
  }
}

async function getIssueMetaSafe(env: Env, issueId: string): Promise<{ labels: Array<{ name: string }>; assignees: string[] }> {
  try {
    const meta = await createRequestScope(env).get(Tokens.CollaborationService).getIssueMeta(issueId);
    return { labels: meta.labels, assignees: meta.assignees };
  } catch {
    return { labels: [], assignees: [] };
  }
}

async function resolveRepoRow(env: Env, owner: string, repoParam: string, email: string | null) {
  const repoName = RepoFullName.normalizeRepo(repoParam);
  const row = await requireVisibleRepo(env, owner, repoName, email);
  return row ? { row, repoName } : null;
}

export { parseNumber, needWrite, needAdmin, getIssueMetaSafe, resolveRepoRow };
export type { CollabApp };
