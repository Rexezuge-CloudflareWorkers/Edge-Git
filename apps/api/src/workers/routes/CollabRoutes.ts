import type { Hono } from 'hono';
import { requireVisibleRepo, toServiceStatus, withPublicRepo } from './PublicViewerResolver';
import { recordAndNotify } from './SocialEmit';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { matchCodeowners, parseCodeowners } from '@edge-git/backend-services/collab';
import { getRepoStub } from '../repoStub';

type CollabApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parseNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
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

function registerCollabPublicRoutes(app: CollabApp): void {
  app.get('/repos/:owner/:repo/labels', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      try {
        const labels = await createRequestScope(c.env).get(Tokens.CollaborationService).listLabels(row.id);
        return c.json({ labels });
      } catch {
        return c.json({ labels: [] });
      }
    });
  });

  app.get('/repos/:owner/:repo/milestones', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      try {
        const milestones = await createRequestScope(c.env).get(Tokens.CollaborationService).listMilestones(row.id);
        return c.json({ milestones });
      } catch {
        return c.json({ milestones: [] });
      }
    });
  });

  app.get('/repos/:owner/:repo/blame', async (c) => {
    return withPublicRepo(c as never, async (_row, fullName) => {
      const ref = c.req.query('ref') || 'HEAD';
      const path = c.req.query('path') || '';
      if (!path) return c.json({ error: 'path is required' }, 400);
      try {
        const blame = await getRepoStub(c.env, fullName).getBlame({ ref, filepath: path });
        if (!blame) return c.json({ error: 'Not found' }, 404);
        return c.json({ blame });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to load blame' }, 500);
      }
    });
  });
}

function registerCollabUserRoutes(app: CollabApp): void {
  // Labels
  app.get('/user/repos/:owner/:repo/labels', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      const labels = await createRequestScope(c.env).get(Tokens.CollaborationService).listLabels(row.id);
      return c.json({ labels });
    } catch {
      return c.json({ labels: [] });
    }
  });

  app.post('/user/repos/:owner/:repo/labels', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await needAdmin(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; color?: string; description?: string };
    try {
      const created = await createRequestScope(c.env)
        .get(Tokens.CollaborationService)
        .createLabel(row.id, body as { name: string });
      return c.json(created, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to create label' }, toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/labels/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await needAdmin(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
    try {
      await createRequestScope(c.env).get(Tokens.CollaborationService).deleteLabel(row.id, c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  // Milestones
  app.get('/user/repos/:owner/:repo/milestones', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      const milestones = await createRequestScope(c.env).get(Tokens.CollaborationService).listMilestones(row.id);
      return c.json({ milestones });
    } catch {
      return c.json({ milestones: [] });
    }
  });

  app.post('/user/repos/:owner/:repo/milestones', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; description?: string; dueOn?: number };
    if (!body.title?.trim()) return c.json({ error: 'title is required' }, 400);
    try {
      const created = await createRequestScope(c.env)
        .get(Tokens.CollaborationService)
        .createMilestone(row.id, body as { title: string });
      return c.json(created, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to create milestone' }, toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/milestones/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    try {
      await createRequestScope(c.env).get(Tokens.CollaborationService).updateMilestone(row.id, c.req.param('id'), body);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to update milestone' }, toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/milestones/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
    try {
      await createRequestScope(c.env).get(Tokens.CollaborationService).deleteMilestone(row.id, c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  // Issue triage: labels / assignees / milestone + meta
  app.get('/user/repos/:owner/:repo/issues/:number/meta', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const issue = await createRequestScope(c.env).get(Tokens.IssueService).getByNumber(row.id, number);
      const meta = await getIssueMetaSafe(c.env, issue.id);
      return c.json({ issue, ...meta, milestoneId: (issue as { milestone_id?: string | null }).milestone_id ?? null });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  for (const kind of ['labels', 'assignees', 'milestone'] as const) {
    app.put(`/user/repos/:owner/:repo/issues/:number/${kind}`, async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const owner = c.req.param('owner');
      const repoName = RepoService.normalizeRepo(c.req.param('repo'));
      const row = await requireVisibleRepo(c.env, owner, repoName, email);
      if (!row) return c.json({ error: 'Not found' }, 404);
      if (!(await needWrite(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
      const number = parseNumber(c.req.param('number'));
      if (number === null) return c.json({ error: 'Not found' }, 404);
      const body = (await c.req.json().catch(() => ({}))) as { labelIds?: string[]; assignees?: string[]; milestoneId?: string | null };
      try {
        const scope = createRequestScope(c.env);
        const issue = await scope.get(Tokens.IssueService).getByNumber(row.id, number);
        const collab = scope.get(Tokens.CollaborationService);
        if (kind === 'labels') await collab.setIssueLabels(issue.id, row.id, body.labelIds ?? []);
        else if (kind === 'assignees') await collab.setIssueAssignees(issue.id, body.assignees ?? []);
        else await collab.setIssueMilestone(issue.id, row.id, body.milestoneId ?? null);
        return c.json({ ok: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to update issue' }, toServiceStatus(error));
      }
    });
  }

  // Pull triage: labels / assignees / milestone + meta
  app.get('/user/repos/:owner/:repo/pulls/:number/meta', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const scope = createRequestScope(c.env);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      let meta = { labels: [], assignees: [], reviewers: [] } as { labels: unknown[]; assignees: unknown[]; reviewers: unknown[] };
      try {
        meta = await scope.get(Tokens.CollaborationService).getPullMeta(pull.id);
      } catch {
        // legacy DB without collab tables
      }
      return c.json({ pull, ...meta });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  for (const kind of ['labels', 'assignees', 'milestone'] as const) {
    app.put(`/user/repos/:owner/:repo/pulls/:number/${kind}`, async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const owner = c.req.param('owner');
      const repoName = RepoService.normalizeRepo(c.req.param('repo'));
      const row = await requireVisibleRepo(c.env, owner, repoName, email);
      if (!row) return c.json({ error: 'Not found' }, 404);
      if (!(await needWrite(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
      const number = parseNumber(c.req.param('number'));
      if (number === null) return c.json({ error: 'Not found' }, 404);
      const body = (await c.req.json().catch(() => ({}))) as { labelIds?: string[]; assignees?: string[]; milestoneId?: string | null };
      try {
        const scope = createRequestScope(c.env);
        const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
        const collab = scope.get(Tokens.CollaborationService);
        if (kind === 'labels') await collab.setPullLabels(pull.id, row.id, body.labelIds ?? []);
        else if (kind === 'assignees') await collab.setPullAssignees(pull.id, body.assignees ?? []);
        else await collab.setPullMilestone(pull.id, row.id, body.milestoneId ?? null);
        return c.json({ ok: true });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to update pull request' }, toServiceStatus(error));
      }
    });
  }

  // Reviewers + drafts + CODEOWNERS suggestions
  app.get('/user/repos/:owner/:repo/pulls/:number/reviewers', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const scope = createRequestScope(c.env);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const reviewers = await scope
        .get(Tokens.CollaborationService)
        .listReviewers(pull.id)
        .catch(() => []);
      return c.json({ reviewers });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/pulls/:number/reviewers', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { reviewers?: string[] };
    try {
      const scope = createRequestScope(c.env);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      await scope.get(Tokens.CollaborationService).requestReviewers(pull.id, body.reviewers ?? []);
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        actorEmail: email,
        type: 'pr_commented',
        title: `Review requested on pull request #${pull.number}: ${pull.title}`,
        subjectType: 'pull',
        subjectNumber: pull.number,
        participantEmails: [pull.creator_email],
        mentionText: Array.isArray(body.reviewers) ? body.reviewers.join(' ') : null,
      }).catch(() => undefined);
      return c.json({ ok: true }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to request reviewers' }, toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/pulls/:number/reviewers/:reviewer', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const scope = createRequestScope(c.env);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      await scope.get(Tokens.CollaborationService).removeReviewer(pull.id, decodeURIComponent(c.req.param('reviewer')));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/pulls/:number/draft', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { isDraft?: boolean };
    if (typeof body.isDraft !== 'boolean') return c.json({ error: 'isDraft must be a boolean' }, 400);
    try {
      const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).setDraft(row.id, number, body.isDraft);
      return c.json({ pull });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to update draft' }, toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number/codeowners', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const scope = createRequestScope(c.env);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const fullName = `${owner}/${repoName}`;
      const stub = getRepoStub(c.env, fullName);
      let content = '';
      for (const candidate of ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']) {
        try {
          const blob = (await stub.getBlob({ ref: pull.base_branch, filepath: candidate })) as {
            contentBase64?: string;
            isBinary?: boolean;
          } | null;
          if (blob?.contentBase64 && !blob.isBinary) {
            const binary = atob(blob.contentBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0;
            content = new TextDecoder().decode(bytes).slice(0, 20_000);
            if (content.trim()) break;
          }
        } catch {
          continue;
        }
      }
      if (!content.trim()) return c.json({ owners: [], rules: 0 });
      const rules = parseCodeowners(content);
      // Suggest owners from files changed in the PR diff (cap 50 paths).
      let owners: string[] = [];
      try {
        const diff = (await stub.getPullDiff({ baseOid: pull.base_oid ?? null, headOid: pull.head_oid ?? '' })) as {
          changes?: Array<{ path: string }>;
        } | null;
        const paths = (diff?.changes ?? []).slice(0, 50).map((ch) => ch.path);
        const found = new Set<string>();
        for (const p of paths) for (const o of matchCodeowners(rules, p)) found.add(o);
        owners = [...found].slice(0, 20);
      } catch {
        owners = [...new Set(rules.flatMap((r) => r.owners))].slice(0, 20);
      }
      return c.json({ owners, rules: rules.length });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  // Fork sync preview + sync (fork pulls upstream changes)
  app.get('/user/repos/:owner/:repo/sync-preview', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const upstreamOwner = c.req.query('upstreamOwner') || '';
    const upstreamRepo = c.req.query('upstreamRepo') ? RepoService.normalizeRepo(c.req.query('upstreamRepo') as string) : '';
    const upstreamBranch = c.req.query('upstreamBranch') || 'main';
    const branch = c.req.query('branch') || 'main';
    if (!upstreamOwner || !upstreamRepo) return c.json({ error: 'upstreamOwner and upstreamRepo are required' }, 400);
    const upstreamRow = await requireVisibleRepo(c.env, upstreamOwner, upstreamRepo, email);
    if (!upstreamRow) return c.json({ error: 'Not found' }, 404);
    try {
      const fullName = `${owner}/${repoName}`;
      const upstreamFull = `${upstreamOwner}/${upstreamRepo}`;
      const [forkOid, upstreamOid] = await Promise.all([
        getRepoStub(c.env, fullName).resolveRef(`refs/heads/${branch}`),
        getRepoStub(c.env, upstreamFull).resolveRef(`refs/heads/${upstreamBranch}`),
      ]);
      if (!forkOid || !upstreamOid) return c.json({ error: 'branch not found' }, 400);
      const preview = (await getRepoStub(c.env, fullName).getMergePreviewByOids({
        baseOid: forkOid,
        headOid: upstreamOid,
      })) as {
        alreadyMerged: boolean;
        canFastForward: boolean;
        mergeBase: string | null;
      } | null;
      return c.json({
        preview: {
          forkOid,
          upstreamOid,
          alreadyMerged: preview?.alreadyMerged ?? false,
          canFastForward: preview?.canFastForward ?? false,
          mergeBase: preview?.mergeBase ?? null,
        },
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to preview sync' }, 500);
    }
  });

  app.post('/user/repos/:owner/:repo/sync', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return c.json({ error: 'Forbidden' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      upstreamOwner?: string;
      upstreamRepo?: string;
      upstreamBranch?: string;
      branch?: string;
    };
    const upstreamOwner = body.upstreamOwner?.trim() || '';
    const upstreamRepo = body.upstreamRepo ? RepoService.normalizeRepo(body.upstreamRepo) : '';
    if (!upstreamOwner || !upstreamRepo) return c.json({ error: 'upstreamOwner and upstreamRepo are required' }, 400);
    const upstreamRow = await requireVisibleRepo(c.env, upstreamOwner, upstreamRepo, email);
    if (!upstreamRow) return c.json({ error: 'Not found' }, 404);
    const upstreamBranch = body.upstreamBranch?.trim() || 'main';
    const branch = body.branch?.trim() || 'main';
    try {
      const fullName = `${owner}/${repoName}`;
      const upstreamFull = `${upstreamOwner}/${upstreamRepo}`;
      const upstreamOid = await getRepoStub(c.env, upstreamFull).resolveRef(`refs/heads/${upstreamBranch}`);
      if (!upstreamOid) return c.json({ error: 'upstream branch not found' }, 400);
      const exported = (await getRepoStub(c.env, upstreamFull).exportPack([upstreamOid])) as { pack: Uint8Array | null };
      if (exported.pack) await getRepoStub(c.env, fullName).importPack(exported.pack);
      const outcome = (await getRepoStub(c.env, fullName).mergePull({
        baseBranch: branch,
        headOid: upstreamOid,
        authorName: email.split('@', 1)[0] || email,
        authorEmail: email,
        message: `Sync ${branch} from ${upstreamFull}@${upstreamBranch}`,
      })) as { type?: string; commitOid?: string; conflicts?: string[]; reason?: string };
      if (outcome.type === 'conflict')
        return c.json({ error: 'sync conflicts', conflicts: outcome.conflicts ?? [], reason: outcome.reason ?? null }, 409);
      return c.json({ sync: outcome });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to sync fork' }, toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/blame', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    const ref = c.req.query('ref') || 'HEAD';
    const path = c.req.query('path') || '';
    if (!path) return c.json({ error: 'path is required' }, 400);
    try {
      const blame = await getRepoStub(c.env, `${owner}/${repoName}`).getBlame({ ref, filepath: path });
      if (!blame) return c.json({ error: 'Not found' }, 404);
      return c.json({ blame });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to load blame' }, 500);
    }
  });
}

export { registerCollabPublicRoutes, registerCollabUserRoutes };
