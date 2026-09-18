import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { CollaborationDAO, PullRequestDAO } from '@edge-git/backend-data/dao';
import { CollaborationService } from '@edge-git/backend-services/collab';
import { PullRequestService } from '@edge-git/backend-services/pull';
// NOTE: relative imports bypass packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node test env).
import { GitService } from '../packages/git-service/src/GitService';
import { HistoryService } from '../packages/git-service/src/HistoryService';
import { MergeService } from '../packages/git-service/src/MergeService';
import { ReadModelService } from '@edge-git/background/ReadModelService';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

interface CollabState {
  repos: Array<Record<string, unknown>>;
  users: Array<Record<string, unknown>>;
  namespaces: Array<Record<string, unknown>>;
  issues: Array<Record<string, unknown>>;
  pulls: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  labels: Array<Record<string, unknown>>;
  milestones: Array<Record<string, unknown>>;
  issueLabels: Array<{ issue_id: string; label_id: string }>;
  issueAssignees: Array<{ issue_id: string; user_email: string }>;
  pullLabels: Array<{ pull_request_id: string; label_id: string }>;
  pullAssignees: Array<{ pull_request_id: string; user_email: string }>;
  reviewers: Array<Record<string, unknown>>;
}

// Full in-memory D1 fake: repos/users/namespaces + issues/pulls + collab tables.
// Unknown social tables fall through to empty/success so recordAndNotify stays best-effort.
function createFullFakeDb() {
  const state: CollabState = {
    repos: [],
    users: [],
    namespaces: [],
    issues: [],
    pulls: [],
    reviews: [],
    labels: [],
    milestones: [],
    issueLabels: [],
    issueAssignees: [],
    pullLabels: [],
    pullAssignees: [],
    reviewers: [],
  };

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    const P = (i: number): string => String(params[i] ?? '');
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM repositories WHERE lower(owner)')) {
          const row = state.repos.find((r) => String(r.owner).toLowerCase() === P(0).toLowerCase() && String(r.name).toLowerCase() === P(1).toLowerCase());
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE owner = ? AND name = ?')) {
          const row = state.repos.find((r) => r.owner === params[0] && r.name === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE id = ?')) {
          const row = state.repos.find((r) => r.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE lower(email)')) {
          const row = state.users.find((u) => String(u.email).toLowerCase() === P(0).toLowerCase());
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE lower(username)')) {
          const row = state.users.find((u) => String(u.username ?? '').toLowerCase() === P(0).toLowerCase());
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM namespaces WHERE username_ci = ?')) {
          const row = state.namespaces.find((n) => n.username_ci === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('COALESCE(MAX(number)') && q.includes('FROM issues')) {
          const max = state.issues.filter((i) => i.repository_id === params[0]).reduce((m, i) => Math.max(m, i.number as number), 0);
          return Promise.resolve({ max_n: max } as unknown as T);
        }
        if (q.includes('COALESCE(MAX(number)') && q.includes('FROM pull_requests')) {
          const max = state.pulls.filter((p) => p.repository_id === params[0]).reduce((m, p) => Math.max(m, p.number as number), 0);
          return Promise.resolve({ max_n: max } as unknown as T);
        }
        if (q.includes('FROM issues WHERE repository_id = ? AND number = ?')) {
          const row = state.issues.find((i) => i.repository_id === params[0] && i.number === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM pull_requests WHERE repository_id = ? AND number = ?')) {
          const row = state.pulls.find((p) => p.repository_id === params[0] && p.number === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM labels WHERE repository_id = ? AND name = ?')) {
          const row = state.labels.find((l) => l.repository_id === params[0] && l.name === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM labels WHERE id = ?')) {
          const row = state.labels.find((l) => l.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM milestones WHERE id = ?')) {
          const row = state.milestones.find((m) => m.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM labels WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.labels.filter((l) => l.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM milestones WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.milestones.filter((m) => m.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM issues WHERE repository_id = ?')) {
          const rows = state.issues
            .filter((i) => i.repository_id === params[0])
            .sort((a, b) => (b.number as number) - (a.number as number))
            .slice(0, Number(params[1] ?? 50));
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM pull_requests WHERE repository_id = ?')) {
          const rows = state.pulls
            .filter((p) => p.repository_id === params[0])
            .sort((a, b) => (b.number as number) - (a.number as number))
            .slice(0, Number(params[1] ?? 50));
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM pull_request_reviews WHERE pull_request_id = ?')) {
          return Promise.resolve({ results: state.reviews.filter((r) => r.pull_request_id === params[0]) as T[] });
        }
        if (q.includes('FROM labels l INNER JOIN issue_labels')) {
          const ids = new Set(state.issueLabels.filter((il) => il.issue_id === params[0]).map((il) => il.label_id));
          return Promise.resolve({ results: state.labels.filter((l) => ids.has(l.id as string)) as T[] });
        }
        if (q.includes('FROM labels l INNER JOIN pull_labels')) {
          const ids = new Set(state.pullLabels.filter((pl) => pl.pull_request_id === params[0]).map((pl) => pl.label_id));
          return Promise.resolve({ results: state.labels.filter((l) => ids.has(l.id as string)) as T[] });
        }
        if (q.includes('FROM issue_assignees WHERE issue_id = ?')) {
          return Promise.resolve({ results: state.issueAssignees.filter((a) => a.issue_id === params[0]).map((a) => ({ email: a.user_email })) as T[] });
        }
        if (q.includes('FROM pull_assignees WHERE pull_request_id = ?')) {
          return Promise.resolve({ results: state.pullAssignees.filter((a) => a.pull_request_id === params[0]).map((a) => ({ email: a.user_email })) as T[] });
        }
        if (q.includes('FROM pull_reviewers WHERE pull_request_id = ?')) {
          return Promise.resolve({ results: state.reviewers.filter((r) => r.pull_request_id === params[0]) as T[] });
        }
        return Promise.resolve({ results: [] as T[] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO users')) {
          const [email, created_at] = params as Array<string | number>;
          if (!state.users.some((u) => u.email === email)) state.users.push({ email, created_at, username: null });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE users SET username')) {
          const row = state.users.find((u) => u.email === params[params.length - 1]);
          if (row && (row.username === null || row.username === undefined || q.includes('username = ?,'))) row.username = params[0] as string;
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT INTO namespaces') || q.startsWith('INSERT OR IGNORE INTO namespaces')) {
          const [username_ci, kind, user_email] = params as Array<string | number | null>;
          if (!state.namespaces.some((n) => n.username_ci === username_ci)) state.namespaces.push({ username_ci, kind, user_email });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT INTO issues')) {
          const [id, repository_id, full_name, number, title, body, status, creator_email, created_at, updated_at] = params as Array<string | number | null>;
          state.issues.push({ id, repository_id, full_name, number, title, body, status, creator_email, created_at, updated_at, milestone_id: null });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE issues SET status = ?')) {
          const row = state.issues.find((i) => i.id === params[2]);
          if (row) {
            row.status = params[0];
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE issues SET milestone_id = ? WHERE id = ?')) {
          const row = state.issues.find((i) => i.id === params[1]);
          if (row) row.milestone_id = params[0];
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE issues SET milestone_id = NULL')) {
          for (const i of state.issues) if (i.milestone_id === params[0]) i.milestone_id = null;
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT INTO pull_requests')) {
          const [id, repository_id, full_name, number, title, body, status, base_branch, head_branch, base_oid, head_oid, merge_base_oid, creator_email] =
            params as Array<string | number | null>;
          state.pulls.push({ id, repository_id, full_name, number, title, body, status, base_branch, head_branch, base_oid, head_oid, merge_base_oid, creator_email, merged_by: null, merged_at: null, created_at: 1, updated_at: 2, is_draft: 0, milestone_id: null });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE pull_requests SET status = ?') && q.includes('merged_by')) {
          const row = state.pulls.find((p) => p.id === params[params.length - 1]);
          if (row) {
            row.status = 'merged';
            row.merged_by = params[1];
            row.merged_at = params[2];
          }
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE pull_requests SET status = ?')) {
          const row = state.pulls.find((p) => p.id === params[2]);
          if (row) row.status = params[0];
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE pull_requests SET base_oid')) {
          const row = state.pulls.find((p) => p.id === params[params.length - 1]);
          if (row) {
            if (params[0]) row.base_oid = params[0];
            if (params[1]) row.head_oid = params[1];
          }
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE pull_requests SET is_draft = ?')) {
          const row = state.pulls.find((p) => p.id === params[2]);
          if (row) row.is_draft = params[0];
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE pull_requests SET milestone_id = ? WHERE id = ?')) {
          const row = state.pulls.find((p) => p.id === params[1]);
          if (row) row.milestone_id = params[0];
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE pull_requests SET milestone_id = ?,')) {
          const row = state.pulls.find((p) => p.id === params[2]);
          if (row) row.milestone_id = params[0];
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE pull_requests SET milestone_id = NULL')) {
          for (const p of state.pulls) if (p.milestone_id === params[0]) p.milestone_id = null;
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT INTO pull_request_reviews')) {
          const [id, pull_request_id, author_email, rstate, body, commit_oid, created_at] = params as Array<string | number | null>;
          state.reviews.push({ id, pull_request_id, author_email, state: rstate, body, commit_oid, created_at });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT INTO labels')) {
          const [id, repository_id, name, color, description, created_at] = params as Array<string | number | null>;
          state.labels.push({ id, repository_id, name, color, description, created_at });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('DELETE FROM labels WHERE id = ?')) {
          state.labels = state.labels.filter((l) => !(l.id === params[0] && l.repository_id === params[1]));
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('DELETE FROM labels WHERE repository_id = ?')) {
          state.labels = state.labels.filter((l) => l.repository_id !== params[0]);
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT INTO milestones')) {
          const [id, repository_id, title, description, due_on, created_at] = params as Array<string | number | null>;
          state.milestones.push({ id, repository_id, title, description, due_on, status: 'open', created_at });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE milestones SET status = ?')) {
          const row = state.milestones.find((m) => m.id === params[1]);
          if (row) row.status = params[0];
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('DELETE FROM milestones WHERE id = ?')) {
          state.milestones = state.milestones.filter((m) => !(m.id === params[0]));
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('DELETE FROM milestones WHERE repository_id = ?')) {
          state.milestones = state.milestones.filter((m) => m.repository_id !== params[0]);
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('DELETE FROM issue_labels WHERE issue_id = ?')) {
          state.issueLabels = state.issueLabels.filter((il) => il.issue_id !== params[0]);
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT OR IGNORE INTO issue_labels')) {
          if (!state.issueLabels.some((il) => il.issue_id === params[0] && il.label_id === params[1])) state.issueLabels.push({ issue_id: params[0] as string, label_id: params[1] as string });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('DELETE FROM issue_assignees WHERE issue_id = ?')) {
          state.issueAssignees = state.issueAssignees.filter((a) => a.issue_id !== params[0]);
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT OR IGNORE INTO issue_assignees')) {
          if (!state.issueAssignees.some((a) => a.issue_id === params[0] && a.user_email === params[1])) state.issueAssignees.push({ issue_id: params[0] as string, user_email: params[1] as string });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('DELETE FROM pull_labels WHERE pull_request_id = ?')) {
          state.pullLabels = state.pullLabels.filter((pl) => pl.pull_request_id !== params[0]);
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT OR IGNORE INTO pull_labels')) {
          if (!state.pullLabels.some((pl) => pl.pull_request_id === params[0] && pl.label_id === params[1])) state.pullLabels.push({ pull_request_id: params[0] as string, label_id: params[1] as string });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('DELETE FROM pull_assignees WHERE pull_request_id = ?')) {
          state.pullAssignees = state.pullAssignees.filter((a) => a.pull_request_id !== params[0]);
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT OR IGNORE INTO pull_assignees')) {
          if (!state.pullAssignees.some((a) => a.pull_request_id === params[0] && a.user_email === params[1])) state.pullAssignees.push({ pull_request_id: params[0] as string, user_email: params[1] as string });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('INSERT OR IGNORE INTO pull_reviewers')) {
          const [pull_request_id, user_email, created_at] = params as Array<string | number>;
          if (!state.reviewers.some((r) => r.pull_request_id === pull_request_id && r.user_email === user_email)) state.reviewers.push({ pull_request_id, user_email, status: 'pending', created_at });
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('DELETE FROM pull_reviewers WHERE pull_request_id = ?')) {
          state.reviewers = state.reviewers.filter((r) => !(r.pull_request_id === params[0] && r.user_email === params[1]));
          return Promise.resolve({ success: true });
        }
        if (q.startsWith('UPDATE pull_reviewers SET status = ?')) {
          const row = state.reviewers.find((r) => r.pull_request_id === params[1] && r.user_email === params[2]);
          if (row) row.status = params[0];
          return Promise.resolve({ success: true });
        }
        return Promise.resolve({ success: true });
      },
    };
  }

  const db = { ...state, prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) };
  return db as unknown as D1Queryable & CollabState;
}

function seedRepo(db: D1Queryable & CollabState) {
  db.repos.push({ id: 'r1', owner_email: 'alice@example.com', owner: 'alice', name: 'demo', description: null, is_private: 0, created_at: 1, updated_at: 2 });
  db.users.push({ email: 'alice@example.com', created_at: 1, username: 'alice' });
  db.issues.push({ id: 'iss-1', repository_id: 'r1', full_name: 'alice/demo', number: 1, title: 'Bug', body: null, status: 'open', creator_email: 'alice@example.com', created_at: 1, updated_at: 1, milestone_id: null });
  db.pulls.push({ id: 'pr-1', repository_id: 'r1', full_name: 'alice/demo', number: 1, title: 'Feat', body: null, status: 'open', base_branch: 'main', head_branch: 'feat', base_oid: OID_A, head_oid: OID_B, merge_base_oid: OID_A, creator_email: 'alice@example.com', merged_by: null, merged_at: null, created_at: 1, updated_at: 1, is_draft: 0, milestone_id: null });
}

describe('CollaborationDAO full coverage', () => {
  it('exercises every DAO method', async () => {
    const db = createFullFakeDb();
    seedRepo(db);
    const dao = new CollaborationDAO(db);
    expect(await dao.getLabelByName('r1', 'missing')).toBeNull();
    await dao.createLabel({ id: 'l1', repositoryId: 'r1', name: 'bug', color: 'ff0000', description: 'Bugs', now: 1 });
    await dao.createLabel({ id: 'l2', repositoryId: 'r1', name: 'feat', color: '00ff00', description: null, now: 1 });
    expect((await dao.listLabels('r1')).map((l) => l.name)).toEqual(['bug', 'feat']);
    expect(await dao.getLabelById('l1', 'r1')).toMatchObject({ name: 'bug' });
    expect(await dao.getLabelByName('r1', 'bug')).toMatchObject({ id: 'l1' });
    await dao.createMilestone({ id: 'm1', repositoryId: 'r1', title: 'v1', description: 'First', dueOn: 99, now: 1 });
    expect(await dao.getMilestone('m1', 'r1')).toMatchObject({ title: 'v1' });
    expect((await dao.listMilestones('r1')).map((m) => m.title)).toEqual(['v1']);
    await dao.setMilestoneStatus('m1', 'r1', 'closed');
    expect((await dao.getMilestone('m1', 'r1'))?.status).toBe('closed');
    await dao.setMilestoneStatus('m1', 'r1', 'open');
    await dao.setIssueLabels('iss-1', ['l1', 'l2']);
    expect((await dao.listIssueLabels('iss-1')).map((l) => l.name)).toEqual(['bug', 'feat']);
    await dao.setIssueAssignees('iss-1', ['bob@example.com'], 2);
    expect(await dao.listIssueAssignees('iss-1')).toEqual(['bob@example.com']);
    await dao.setIssueMilestone('iss-1', 'm1');
    await dao.setPullLabels('pr-1', ['l1']);
    expect((await dao.listPullLabels('pr-1')).map((l) => l.name)).toEqual(['bug']);
    await dao.setPullAssignees('pr-1', ['carol@example.com'], 2);
    expect(await dao.listPullAssignees('pr-1')).toEqual(['carol@example.com']);
    await dao.setPullMilestone('pr-1', 'm1');
    await dao.setPullDraft('pr-1', true);
    await dao.requestReviewers('pr-1', ['dave@example.com'], 3);
    expect(await dao.listReviewers('pr-1')).toHaveLength(1);
    await dao.syncReviewerStatus('pr-1', 'dave@example.com', 'approved');
    expect((await dao.listReviewers('pr-1'))[0].status).toBe('approved');
    await dao.removeReviewer('pr-1', 'dave@example.com');
    expect(await dao.listReviewers('pr-1')).toHaveLength(0);
    await dao.deleteLabel('l2', 'r1');
    expect((await dao.listLabels('r1')).map((l) => l.name)).toEqual(['bug']);
    await dao.deleteMilestone('m1', 'r1');
    expect(await dao.listMilestones('r1')).toHaveLength(0);
    await dao.deleteByRepo('r1');
    expect(await dao.listLabels('r1')).toHaveLength(0);
  });
});

describe('CollaborationService full coverage', () => {
  it('covers validation branches and happy paths', async () => {
    const db = createFullFakeDb();
    seedRepo(db);
    const svc = new CollaborationService({ DB: db });
    expect(svc).toBeInstanceOf(CollaborationService);
    const { id: labelId } = await svc.createLabel('r1', { name: 'bug', color: '#FF0000', description: '  Bugs  ' });
    await expect(svc.createLabel('r1', { name: 'bug' })).rejects.toThrow('already exists');
    await expect(svc.createLabel('r1', { name: 'BUG' })).rejects.toThrow('already exists');
    await expect(svc.createLabel('r1', { name: '' })).rejects.toThrow();
    await expect(svc.createLabel('r1', { name: 'x', color: '12' })).rejects.toThrow();
    expect(await svc.listLabels('r1')).toHaveLength(1);
    await expect(svc.deleteLabel('r1', 'nope')).rejects.toThrow('Label not found');
    const { id: milestoneId } = await svc.createMilestone('r1', { title: ' v1 ', description: ' d ', dueOn: 5 });
    await expect(svc.createMilestone('r1', { title: '' })).rejects.toThrow();
    await expect(svc.createMilestone('r1', { title: 'x'.repeat(101) })).rejects.toThrow();
    expect(await svc.listMilestones('r1')).toHaveLength(1);
    await expect(svc.updateMilestone('r1', 'nope', { status: 'open' })).rejects.toThrow('Milestone not found');
    await expect(svc.updateMilestone('r1', milestoneId, { status: 'bogus' })).rejects.toThrow('open or closed');
    await svc.updateMilestone('r1', milestoneId, { status: 'closed' });
    await expect(svc.deleteMilestone('r1', 'nope')).rejects.toThrow('Milestone not found');
    await svc.setIssueLabels('iss-1', 'r1', [labelId]);
    await expect(svc.setIssueLabels('iss-1', 'r1', ['unknown'])).rejects.toThrow('unknown label');
    await expect(svc.setIssueLabels('iss-1', 'r1', 'nope')).rejects.toThrow('array');
    await svc.setIssueAssignees('iss-1', ['Bob@Example.com', 'bob@example.com']);
    await expect(svc.setIssueAssignees('iss-1', 'nope')).rejects.toThrow('array');
    await expect(svc.setIssueAssignees('iss-1', Array.from({ length: 11 }, (_, i) => `u${i}@x.com`))).rejects.toThrow('at most');
    await expect(svc.setIssueAssignees('iss-1', [''])).rejects.toThrow('non-empty');
    await expect(svc.setIssueAssignees('iss-1', ['has space'])).rejects.toThrow();
    await svc.setIssueMilestone('iss-1', 'r1', milestoneId);
    await expect(svc.setIssueMilestone('iss-1', 'r1', 'nope')).rejects.toThrow('unknown milestone');
    await svc.setIssueMilestone('iss-1', 'r1', null);
    expect(await svc.getIssueMeta('iss-1')).toMatchObject({ assignees: ['bob@example.com'] });
    await svc.setPullLabels('pr-1', 'r1', [labelId]);
    await expect(svc.setPullLabels('pr-1', 'r1', ['unknown'])).rejects.toThrow('unknown label');
    await svc.setPullAssignees('pr-1', ['carol@example.com']);
    await svc.setPullMilestone('pr-1', 'r1', milestoneId);
    await expect(svc.setPullMilestone('pr-1', 'r1', 'nope')).rejects.toThrow('unknown milestone');
    await svc.setPullMilestone('pr-1', 'r1', null);
    expect((await svc.getPullMeta('pr-1')).labels).toHaveLength(1);
    await svc.requestReviewers('pr-1', ['dave@example.com']);
    await expect(svc.requestReviewers('pr-1', Array.from({ length: 11 }, (_, i) => `r${i}@x.com`))).rejects.toThrow('at most');
    await expect(svc.requestReviewers('pr-1', ['bad reviewer!'])).rejects.toThrow();
    expect(await svc.listReviewers('pr-1')).toHaveLength(1);
    await svc.syncReviewerStatus('pr-1', 'dave@example.com', 'approved');
    await svc.removeReviewer('pr-1', 'dave@example.com');
    expect(await svc.listReviewers('pr-1')).toHaveLength(0);
    await svc.deleteLabel('r1', labelId);
    await svc.deleteMilestone('r1', milestoneId);
  });
});

describe('PullRequest draft and milestone DAO', () => {
  it('sets drafts and milestones through service and DAO', async () => {
    const db = createFullFakeDb();
    seedRepo(db);
    const svc = new PullRequestService({ DB: db });
    const updated = await svc.setDraft('r1', 1, true);
    expect(updated.is_draft).toBe(1);
    await expect(svc.markMerged({ repositoryId: 'r1', number: 1, mergedBy: 'alice@example.com' })).rejects.toThrow('draft');
    await svc.setDraft('r1', 1, false);
    const dao = new PullRequestDAO(db);
    await dao.setDraft('pr-1', false, 9);
    await dao.setMilestone('pr-1', null, 9);
    await expect(svc.setDraft('r1', 1, true)).resolves.toMatchObject({ number: 1 });
    await svc.setDraft('r1', 1, false);
  });
});

describe('Collab API routes', () => {
  const json = { 'content-type': 'application/json' };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };

  function createStub(overrides: Record<string, (...args: never[]) => Promise<unknown>> = {}) {
    const calls: Array<{ method: string; args: unknown }> = [];
    const record = (method: string) => async (...args: never[]) => {
      calls.push({ method, args });
      return (overrides[method] as ((...a: never[]) => Promise<unknown>) | undefined)?.(...args) ?? defaults[method]();
    };
    const defaults: Record<string, () => Promise<unknown>> = {
      setFullName: () => Promise.resolve(),
      ensureRepoInitialized: () => Promise.resolve(),
      getMergePreview: () => Promise.resolve({ baseOid: OID_A, headOid: OID_B, mergeBase: OID_A, alreadyMerged: false, canFastForward: true }),
      getPullDiff: () => Promise.resolve({ mergeBase: OID_A, truncated: false, changes: [{ type: 'add', path: 'f.txt' }] }),
      mergePull: () => Promise.resolve({ type: 'fast-forward', commitOid: OID_B }),
      getBlob: () => Promise.resolve(null),
      getBlame: () => Promise.resolve({ oid: OID_A, lines: [{ line: 1, commitOid: OID_A, author: 'a@x.com', content: 'hi' }], truncated: false }),
      resolveRef: () => Promise.resolve(OID_B),
      getMergePreviewByOids: () => Promise.resolve({ baseOid: OID_A, headOid: OID_B, mergeBase: OID_A, alreadyMerged: false, canFastForward: true }),
      exportPack: () => Promise.resolve({ oids: [], pack: null }),
      importPack: () => Promise.resolve({ importedRefs: [] }),
    };
    const stub: Record<string, (...args: never[]) => Promise<unknown>> = {};
    for (const method of Object.keys(defaults)) stub[method] = record(method);
    return { stub, calls };
  }

  function createEnv(db: D1Queryable, stub: unknown) {
    return { DB: db, REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n }, ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'alice@example.com' };
  }

  async function call(env: unknown, path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    const worker = new EdgeGitWorker();
    const onRequest = (worker as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> }).onRequest.bind(worker);
    const res = await onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  it('manages labels and milestones', async () => {
    const db = createFullFakeDb();
    seedRepo(db);
    const { stub } = createStub();
    const env = createEnv(db, stub);
    expect((await call(env, '/repos/alice/demo/labels')).status).toBe(200);
    expect((await call(env, '/repos/alice/demo/milestones')).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/labels')).status).toBe(200);
    const created = await call(env, '/user/repos/alice/demo/labels', { method: 'POST', headers: json, body: JSON.stringify({ name: 'bug', color: 'ff0000' }) });
    expect(created.status).toBe(201);
    expect((await call(env, '/user/repos/alice/demo/labels', { method: 'POST', headers: json, body: JSON.stringify({ name: 'bug' }) })).status).toBe(400);
    const labelId = (created.body as { id: string }).id;
    expect((await call(env, `/user/repos/alice/demo/labels/${labelId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/labels/nope', { method: 'DELETE' })).status).toBe(404);
    const milestone = await call(env, '/user/repos/alice/demo/milestones', { method: 'POST', headers: json, body: JSON.stringify({ title: 'v1' }) });
    expect(milestone.status).toBe(201);
    expect((await call(env, '/user/repos/alice/demo/milestones', { method: 'POST', headers: json, body: '{}' })).status).toBe(400);
    const milestoneId = (milestone.body as { id: string }).id;
    expect((await call(env, `/user/repos/alice/demo/milestones/${milestoneId}`, { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'bogus' }) })).status).toBe(400);
    expect((await call(env, `/user/repos/alice/demo/milestones/${milestoneId}`, { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'closed' }) })).status).toBe(200);
    expect((await call(env, `/user/repos/alice/demo/milestones/${milestoneId}`, { method: 'DELETE' })).status).toBe(200);
  });

  it('triages issues with labels, assignees, milestones, and filters', async () => {
    const db = createFullFakeDb();
    seedRepo(db);
    const { stub } = createStub();
    const env = createEnv(db, stub);
    const label = (await call(env, '/user/repos/alice/demo/labels', { method: 'POST', headers: json, body: JSON.stringify({ name: 'bug' }) })).body as { id: string };
    const milestone = (await call(env, '/user/repos/alice/demo/milestones', { method: 'POST', headers: json, body: JSON.stringify({ title: 'v1' }) })).body as { id: string };
    expect((await call(env, '/user/repos/alice/demo/issues/1/meta')).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/issues/1/labels', { method: 'PUT', headers: json, body: JSON.stringify({ labelIds: [label.id] }) })).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/issues/1/assignees', { method: 'PUT', headers: json, body: JSON.stringify({ assignees: ['bob@example.com'] }) })).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/issues/1/milestone', { method: 'PUT', headers: json, body: JSON.stringify({ milestoneId: milestone.id }) })).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/issues/1/labels', { method: 'PUT', headers: json, body: JSON.stringify({ labelIds: ['nope'] }) })).status).toBe(400);
    const filtered = await call(env, '/repos/alice/demo/issues?label=bug');
    expect(filtered.status).toBe(200);
    expect((filtered.body as { issues: unknown[] }).issues).toHaveLength(1);
    expect(((await call(env, '/repos/alice/demo/issues?label=nope')).body as { issues: unknown[] }).issues).toHaveLength(0);
    expect(((await call(env, '/user/repos/alice/demo/issues?assignee=bob@example.com')).body as { issues: unknown[] }).issues).toHaveLength(1);
    expect(((await call(env, `/user/repos/alice/demo/issues?milestone=${milestone.id}`)).body as { issues: unknown[] }).issues).toHaveLength(1);
  });

  it('triages pulls, requests reviewers, toggles drafts, and suggests codeowners', async () => {
    const db = createFullFakeDb();
    seedRepo(db);
    const { stub } = createStub();
    const env = createEnv(db, stub);
    const label = (await call(env, '/user/repos/alice/demo/labels', { method: 'POST', headers: json, body: JSON.stringify({ name: 'bug' }) })).body as { id: string };
    expect((await call(env, '/user/repos/alice/demo/pulls/1/meta')).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/labels', { method: 'PUT', headers: json, body: JSON.stringify({ labelIds: [label.id] }) })).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/assignees', { method: 'PUT', headers: json, body: JSON.stringify({ assignees: ['c@x.com'] }) })).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/milestone', { method: 'PUT', headers: json, body: JSON.stringify({ milestoneId: null }) })).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/labels', { method: 'PUT', headers: json, body: JSON.stringify({ labelIds: ['nope'] }) })).status).toBe(400);
    expect((await call(env, '/user/repos/alice/demo/pulls?label=bug')).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/reviewers', { method: 'POST', headers: json, body: JSON.stringify({ reviewers: [] }) })).status).toBe(400);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/reviewers', { method: 'POST', headers: json, body: JSON.stringify({ reviewers: ['dave@example.com'] }) })).status).toBe(201);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/reviewers')).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/reviewers/dave%40example.com', { method: 'DELETE' })).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/draft', { method: 'PATCH', headers: json, body: JSON.stringify({ isDraft: 'yes' }) })).status).toBe(400);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/draft', { method: 'PATCH', headers: json, body: JSON.stringify({ isDraft: true }) })).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/draft', { method: 'PATCH', headers: json, body: JSON.stringify({ isDraft: false }) })).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/pulls/1/codeowners')).status).toBe(200);
  });

  it('suggests codeowners from diff paths', async () => {
    const db = createFullFakeDb();
    seedRepo(db);
    const ownersBlob = Buffer.from('*.js @js-team\n').toString('base64');
    const { stub } = createStub({
      getBlob: () => Promise.resolve({ contentBase64: ownersBlob, isBinary: false }),
      getPullDiff: () => Promise.resolve({ mergeBase: OID_A, truncated: false, changes: [{ type: 'modify', path: 'src/app.js' }] }),
    });
    const env = createEnv(db, stub);
    const res = await call(env, '/user/repos/alice/demo/pulls/1/codeowners');
    expect(res.status).toBe(200);
    expect((res.body as { owners: string[] }).owners).toContain('@js-team');
  });

  it('previews and syncs forks with conflict handling', async () => {
    const db = createFullFakeDb();
    seedRepo(db);
    const { stub } = createStub();
    const env = createEnv(db, stub);
    expect((await call(env, '/user/repos/alice/demo/sync-preview')).status).toBe(400);
    expect((await call(env, '/user/repos/alice/demo/sync-preview?upstreamOwner=alice&upstreamRepo=demo&upstreamBranch=main&branch=main')).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/sync', { method: 'POST', headers: json, body: '{}' })).status).toBe(400);
    const synced = await call(env, '/user/repos/alice/demo/sync', { method: 'POST', headers: json, body: JSON.stringify({ upstreamOwner: 'alice', upstreamRepo: 'demo' }) });
    expect(synced.status).toBe(200);
    const { stub: conflictStub } = createStub({ mergePull: () => Promise.resolve({ type: 'conflict', conflicts: ['f.txt'], reason: null }) });
    expect((await call(createEnv(db, conflictStub), '/user/repos/alice/demo/sync', { method: 'POST', headers: json, body: JSON.stringify({ upstreamOwner: 'alice', upstreamRepo: 'demo' }) })).status).toBe(409);
  });

  it('serves blame and gates merges by draft and strategy', async () => {
    const db = createFullFakeDb();
    seedRepo(db);
    const { stub, calls } = createStub();
    const env = createEnv(db, stub);
    expect((await call(env, '/repos/alice/demo/blame')).status).toBe(400);
    expect((await call(env, '/repos/alice/demo/blame?path=f.txt')).status).toBe(200);
    expect((await call(env, '/user/repos/alice/demo/blame?path=f.txt')).status).toBe(200);
    const draftPull = await call(env, '/user/repos/alice/demo/pulls', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Drafted', baseBranch: 'main', headBranch: 'draft-feat', isDraft: true }) });
    expect(draftPull.status).toBe(201);
    const draftNumber = (draftPull.body as { number: number }).number;
    expect((await call(env, `/user/repos/alice/demo/pulls/${draftNumber}/merge`, { method: 'POST', headers: json, body: '{}' })).status).toBe(409);
    expect((await call(env, `/user/repos/alice/demo/pulls/${draftNumber}/draft`, { method: 'PATCH', headers: json, body: JSON.stringify({ isDraft: false }) })).status).toBe(200);
    const merged = await call(env, '/user/repos/alice/demo/pulls/1/merge', { method: 'POST', headers: json, body: JSON.stringify({ strategy: 'squash' }) });
    expect(merged.status).toBe(200);
    expect(calls.some((c) => c.method === 'mergePull' && (c.args[0] as { strategy?: string }).strategy === 'squash')).toBe(true);
  });
});

describe('MergeService squash and rebase', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function writeAndCommit(dir: string, filepath: string, content: string, message: string): Promise<string> {
    await fs.promises.mkdir(path.dirname(path.join(dir, filepath)), { recursive: true });
    await fs.promises.writeFile(path.join(dir, filepath), content);
    await git.add({ fs, dir, filepath });
    return git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message });
  }

  async function makeRepo(): Promise<{ dir: string; gitdir: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-collab-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir, defaultBranch: 'main' });
    await writeAndCommit(dir, 'base.txt', 'base\n', 'init');
    return { dir, gitdir: path.join(dir, '.git') };
  }

  it('squashes a fast-forward head into one commit on base', async () => {
    const { dir, gitdir } = await makeRepo();
    await git.branch({ fs, dir, ref: 'feat', checkout: true });
    const headOid = await writeAndCommit(dir, 'feat.txt', 'feat\n', 'feat one');
    await writeAndCommit(dir, 'feat2.txt', 'more\n', 'feat two');
    await git.checkout({ fs, dir, ref: 'main' });
    const svc = new MergeService(fs as never, gitdir);
    const outcome = (await svc.squashMerge({ baseBranch: 'main', headOid, author: { name: 't', email: 't@x.com' }, message: 'Squashed' })) as { type: string; commitOid: string };
    expect(outcome.type).toBe('fast-forward');
    const baseOid = await git.resolveRef({ fs, dir, ref: 'main' });
    expect(outcome.commitOid).toBe(baseOid);
    const commit = await git.readCommit({ fs, dir, oid: outcome.commitOid });
    expect(commit.commit.parent).toHaveLength(1);
    const head = await git.readCommit({ fs, dir, oid: headOid });
    expect(commit.commit.tree).toBe(head.commit.tree);
  });

  it('reports already-merged and validates squash inputs', async () => {
    const { gitdir } = await makeRepo();
    const svc = new MergeService(fs as never, gitdir);
    const mainOid = await svc.resolveRef('refs/heads/main');
    await expect(svc.squashMerge({ baseBranch: 'main', headOid: mainOid as string, author: { name: 't', email: 't@x.com' } })).resolves.toMatchObject({ type: 'already-merged' });
    await expect(svc.squashMerge({ baseBranch: '../x', headOid: OID_A, author: { name: 't', email: 't@x.com' } })).rejects.toThrow(/invalid base branch/);
    await expect(svc.squashMerge({ baseBranch: 'main', headOid: 'short', author: { name: 't', email: 't@x.com' } })).rejects.toThrow(/invalid head oid/);
    await expect(svc.squashMerge({ baseBranch: 'nope', headOid: OID_A, author: { name: 't', email: 't@x.com' } })).rejects.toThrow(/base branch not found/);
  });

  it('rebase fast-forwards strictly-ahead heads', async () => {
    const { dir, gitdir } = await makeRepo();
    await git.branch({ fs, dir, ref: 'feat', checkout: true });
    const headOid = await writeAndCommit(dir, 'feat.txt', 'feat\n', 'feat');
    await git.checkout({ fs, dir, ref: 'main' });
    const svc = new MergeService(fs as never, gitdir);
    await expect(svc.rebaseMerge({ baseBranch: 'main', headOid, author: { name: 't', email: 't@x.com' } })).resolves.toMatchObject({ type: 'fast-forward', commitOid: headOid });
  });

  it('replays a single divergent commit and conflicts on multi-commit heads', async () => {
    const { dir, gitdir } = await makeRepo();
    await git.branch({ fs, dir, ref: 'feat', checkout: true });
    const headOid = await writeAndCommit(dir, 'feat.txt', 'feat\n', 'feat');
    await git.checkout({ fs, dir, ref: 'main' });
    await writeAndCommit(dir, 'main.txt', 'main\n', 'main work');
    const svc = new MergeService(fs as never, gitdir);
    const replayed = (await svc.rebaseMerge({ baseBranch: 'main', headOid, author: { name: 't', email: 't@x.com' } })) as { type: string; commitOid: string };
    expect(replayed.type).toBe('fast-forward');
    expect(replayed.commitOid).not.toBe(headOid);
    await git.branch({ fs, dir, ref: 'feat2', checkout: true });
    await writeAndCommit(dir, 'a.txt', 'a\n', 'one');
    const multiOid = await writeAndCommit(dir, 'b.txt', 'b\n', 'two');
    await git.checkout({ fs, dir, ref: 'main' });
    await writeAndCommit(dir, 'main2.txt', 'main again\n', 'main diverges');
    await expect(svc.rebaseMerge({ baseBranch: 'main', headOid: multiOid, author: { name: 't', email: 't@x.com' } })).resolves.toMatchObject({ type: 'conflict' });
    await expect(svc.rebaseMerge({ baseBranch: '../x', headOid: OID_A, author: { name: 't', email: 't@x.com' } })).rejects.toThrow(/invalid base branch/);
    await expect(svc.rebaseMerge({ baseBranch: 'main', headOid: 'short', author: { name: 't', email: 't@x.com' } })).rejects.toThrow(/invalid head oid/);
    const mainOid = await svc.resolveRef('refs/heads/main');
    await expect(svc.rebaseMerge({ baseBranch: 'main', headOid: mainOid as string, author: { name: 't', email: 't@x.com' } })).resolves.toMatchObject({ type: 'already-merged' });
  });
});

describe('HistoryService blame and GitService wrappers', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeBlameRepo(): Promise<{ gitdir: string; tip: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-blame-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir, defaultBranch: 'main' });
    await fs.promises.writeFile(path.join(dir, 'notes.txt'), 'one\ntwo\n');
    await git.add({ fs, dir, filepath: 'notes.txt' });
    await git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message: 'first' });
    await fs.promises.writeFile(path.join(dir, 'notes.txt'), 'one\nTWO\nthree\n');
    await git.add({ fs, dir, filepath: 'notes.txt' });
    const tip = await git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message: 'second' });
    return { gitdir: path.join(dir, '.git'), tip };
  }

  it('attributes lines to commits and returns null for unknown refs', async () => {
    const { gitdir, tip } = await makeBlameRepo();
    const svc = new HistoryService(fs as never, gitdir);
    const blame = (await svc.getBlame(tip, 'notes.txt')) as { oid: string; lines: Array<{ line: number; commitOid: string; content: string }>; truncated: boolean } | null;
    expect(blame).not.toBeNull();
    expect(blame?.lines).toHaveLength(4);
    expect(blame?.truncated).toBe(false);
    await expect(svc.getBlame('refs/heads/nope', 'notes.txt')).resolves.toBeNull();
    await expect(svc.getBlame(tip, 'missing.txt')).resolves.toBeNull();
  });

  it('returns null for binary files', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-blame-bin-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir, defaultBranch: 'main' });
    await fs.promises.writeFile(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    await git.add({ fs, dir, filepath: 'bin.dat' });
    const tip = await git.commit({ fs, dir, author: { name: 't', email: 't@x.com' }, message: 'bin' });
    const svc = new HistoryService(fs as never, path.join(dir, '.git'));
    await expect(svc.getBlame(tip, 'bin.dat')).resolves.toBeNull();
  });

  it('delegates squash, rebase, and blame through GitService and ReadModelService', async () => {
    const { gitdir } = await makeBlameRepo();
    const svc = new GitService(fs as never, gitdir);
    await expect(svc.squashMerge({ baseBranch: '../x', headOid: OID_A, author: { name: 't', email: 't@x.com' } })).rejects.toThrow();
    await expect(svc.rebaseMerge({ baseBranch: '../x', headOid: OID_A, author: { name: 't', email: 't@x.com' } })).rejects.toThrow();
    await expect(svc.getBlame('refs/heads/nope', 'notes.txt')).resolves.toBeNull();
    const readModel = new ReadModelService(svc);
    await expect(readModel.getBlame('refs/heads/nope', 'notes.txt')).resolves.toBeNull();
  });
});
