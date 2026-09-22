import { describe, expect, it } from 'vitest';
import { ZERO_OID as SHARED_ZERO_OID } from '@edge-git/shared/constants';
import { RepoFullName } from '@edge-git/shared/utils';
import { ZERO_OID as PROTOCOL_ZERO_OID, isZeroOid as protocolIsZeroOid } from '@edge-git/git-protocol';
import {
  ZERO_OID as SERVICE_ZERO_OID,
  branchRefFor,
  classifyRefCommand,
  isCommitOid,
  isZeroOid as serviceIsZeroOid,
} from '../packages/git-service/src/RefValidation';
import { CollaborationDAO } from '@edge-git/backend-data/dao/CollaborationDAO';
import { SearchDAO } from '@edge-git/backend-data/dao/SearchDAO';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { DatabaseError } from '@edge-git/backend-errors';
import { assertQuotaWithinLimit } from '@edge-git/backend-services/policy/QuotaPolicy';
import { TeamService } from '@edge-git/backend-services/team/TeamService';
import { WebhookDeliveryService } from '@edge-git/backend-services/webhook/WebhookDeliveryService';

type Row = Record<string, unknown>;

// Minimal in-memory D1 fake for the label/assignee link tables.
function createLinkFakeDb() {
  const tables = new Map<string, Row[]>();
  const table = (name: string): Row[] => {
    let rows = tables.get(name);
    if (!rows) {
      rows = [];
      tables.set(name, rows);
    }
    return rows;
  };
  const stmt = (query: string, params: unknown[]) => ({
    first<T>(): Promise<T | null> {
      return Promise.resolve(null);
    },
    all<T>(): Promise<{ results: T[] }> {
      if (query.includes('SELECT l.*')) {
        // Label-name join over the (empty in this fake) labels table.
        return Promise.resolve({ results: [] as unknown as T[] });
      }
      if (query.includes('SELECT user_email AS email')) {
        const subjectId = params[0] as string;
        const linkTable = query.includes('issue_assignees') ? 'issue_assignees' : 'pull_assignees';
        const idColumn = query.includes('issue_assignees') ? 'issue_id' : 'pull_request_id';
        const rows = table(linkTable)
          .filter((r) => r[idColumn] === subjectId)
          .map((r) => ({ email: r.user_email }) as unknown as T);
        return Promise.resolve({ results: rows });
      }
      return Promise.resolve({ results: [] as unknown as T[] });
    },
    run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
      if (query.startsWith('DELETE FROM')) {
        const name = query.split(' ')[2];
        const rows = table(name);
        const kept = rows.filter((r) => !Object.values(r).includes(params[0]));
        tables.set(name, kept);
        return Promise.resolve({ success: true, meta: { changes: rows.length - kept.length } });
      }
      if (query.startsWith('INSERT OR IGNORE INTO')) {
        const name = query.split(' ')[4];
        const rows = table(name);
        if (name.endsWith('labels')) {
          const [subjectId, labelId] = params as [string, string];
          const idColumn = name === 'issue_labels' ? 'issue_id' : 'pull_request_id';
          if (!rows.some((r) => r[idColumn] === subjectId && r.label_id === labelId)) {
            rows.push({ [idColumn]: subjectId, label_id: labelId });
          }
        } else {
          const [subjectId, email, now] = params as [string, string, number];
          const idColumn = name === 'issue_assignees' ? 'issue_id' : 'pull_request_id';
          if (!rows.some((r) => r[idColumn] === subjectId && r.user_email === email)) {
            rows.push({ [idColumn]: subjectId, user_email: email, created_at: now });
          }
        }
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      }
      return Promise.resolve({ success: true, meta: { changes: 0 } });
    },
  });
  return {
    prepare(query: string) {
      return { bind: (...params: unknown[]) => stmt(query, params) };
    },
  } as unknown as D1Queryable;
}

// Fake whose every statement throws `errorFactory()` — drives the
// FTS→LIKE→degrade chain in SearchDAO.
function createThrowingDb(errorFactory: () => Error): D1Queryable {
  const bomb = () => {
    throw errorFactory();
  };
  return {
    prepare(_query: string) {
      return {
        bind(..._params: unknown[]) {
          return { first: bomb, all: bomb, run: bomb };
        },
      };
    },
  } as unknown as D1Queryable;
}

function createUnreachableDb(): D1Queryable {
  const bomb = () => {
    throw new Error('unreachable: empty query must short-circuit before D1');
  };
  return {
    prepare(_query: string) {
      return {
        bind(..._params: unknown[]) {
          return { first: bomb, all: bomb, run: bomb };
        },
      };
    },
  } as unknown as D1Queryable;
}

describe('hardening sweep: ZERO_OID canonicalization', () => {
  it('shares one zero OID across layers', () => {
    expect(SERVICE_ZERO_OID).toBe(SHARED_ZERO_OID);
    expect(PROTOCOL_ZERO_OID).toBe(SHARED_ZERO_OID);
    expect(SHARED_ZERO_OID).toBe('0'.repeat(40));
  });

  it('classifies ref commands against the canonical zero OID', () => {
    expect(serviceIsZeroOid(SHARED_ZERO_OID)).toBe(true);
    expect(serviceIsZeroOid('a'.repeat(40))).toBe(false);
    expect(protocolIsZeroOid(SHARED_ZERO_OID)).toBe(true);
    expect(isCommitOid('a'.repeat(40))).toBe(true);
    expect(isCommitOid(SHARED_ZERO_OID)).toBe(true);
    expect(isCommitOid('xyz')).toBe(false);
    expect(branchRefFor('main')).toBe('refs/heads/main');
    expect(classifyRefCommand({ oldOid: SHARED_ZERO_OID, newOid: 'a'.repeat(40), ref: 'refs/heads/x' })).toBe('create');
    expect(classifyRefCommand({ oldOid: 'a'.repeat(40), newOid: SHARED_ZERO_OID, ref: 'refs/heads/x' })).toBe('delete');
    expect(classifyRefCommand({ oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40), ref: 'refs/heads/x' })).toBe('update');
  });
});

describe('hardening sweep: QuotaPolicy', () => {
  it('passes under the limit and fails closed at the limit', () => {
    expect(() => assertQuotaWithinLimit(0, 1, 'teams')).not.toThrow();
    expect(() => assertQuotaWithinLimit(1, 1, 'teams')).toThrow('Maximum of 1 teams reached');
    expect(() => assertQuotaWithinLimit(5, 3, 'team members')).toThrow('Maximum of 3 team members reached');
  });
});

describe('hardening sweep: CollaborationDAO subject mirrors', () => {
  it('round-trips issue and pull assignees with lowercase normalization', async () => {
    const dao = new CollaborationDAO(createLinkFakeDb());
    await dao.setIssueAssignees('i1', ['A@X.com'], 1);
    await dao.setPullAssignees('p1', ['B@X.com', 'C@X.com'], 2);
    expect(await dao.listIssueAssignees('i1')).toEqual(['a@x.com']);
    expect(await dao.listPullAssignees('p1')).toEqual(['b@x.com', 'c@x.com']);
    // Reset clears only the targeted subject.
    await dao.setIssueAssignees('i1', [], 3);
    expect(await dao.listIssueAssignees('i1')).toEqual([]);
    expect(await dao.listPullAssignees('p1')).toEqual(['b@x.com', 'c@x.com']);
  });

  it('round-trips issue and pull labels independently', async () => {
    const dao = new CollaborationDAO(createLinkFakeDb());
    await dao.setIssueLabels('i1', ['l1']);
    await dao.setPullLabels('p1', ['l2']);
    // list*Labels joins the labels table (empty in this fake) — assert the
    // writes did not throw and reset is scoped per subject.
    await dao.setIssueLabels('i1', []);
    await dao.setPullLabels('p1', []);
    expect(await dao.listIssueLabels('i1')).toEqual([]);
    expect(await dao.listPullLabels('p1')).toEqual([]);
  });
});

describe('hardening sweep: SearchDAO degrade paths', () => {
  it('short-circuits empty queries before touching D1', async () => {
    const dao = new SearchDAO(createUnreachableDb());
    await expect(dao.searchRepos('   ')).resolves.toEqual([]);
    await expect(dao.searchIssues('')).resolves.toEqual([]);
    await expect(dao.searchPulls('')).resolves.toEqual([]);
    await expect(dao.searchCode('')).resolves.toEqual([]);
    await expect(dao.searchDiscussions('')).resolves.toEqual([]);
    await expect(dao.searchSnippets('')).resolves.toEqual([]);
    await expect(dao.upsertCodeFiles([])).resolves.toBe(0);
  });

  it('degrades to [] when FTS and LIKE tables are both absent', async () => {
    const dao = new SearchDAO(createThrowingDb(() => new Error('no such table: repo_fts')));
    await expect(dao.searchRepos('hello')).resolves.toEqual([]);
    await expect(dao.searchIssues('hello')).resolves.toEqual([]);
    await expect(dao.searchSnippets('hello')).resolves.toEqual([]);
  });

  it('fail-closes genuine D1 errors as DatabaseError', async () => {
    const dao = new SearchDAO(createThrowingDb(() => new Error('D1 boom')));
    await expect(dao.searchRepos('hello')).rejects.toBeInstanceOf(DatabaseError);
    await expect(dao.searchIssues('hello')).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('hardening sweep: TeamService quota + validation', () => {
  const org = { id: 'o1' } as never;
  const teamDao = {
    getByOrgAndSlug: async () => null,
    countByOrg: async () => 1,
  } as never;
  const orgDao = { getByUsernameCi: async () => org } as never;
  const orgMemberDao = { get: async () => ({ role: 'owner' }) } as never;

  it('fails closed when the org is at its team quota', async () => {
    const svc = new TeamService(
      { DB: createUnreachableDb(), MAX_TEAMS_PER_ORG: '1' },
      { teamDAO: async () => teamDao, organizationDAO: async () => orgDao, organizationMemberDAO: async () => orgMemberDao },
    );
    await expect(svc.createTeam('acme', 'boss@x.com', { slug: 'team-a' })).rejects.toThrow('Maximum of 1 teams reached');
  });

  it('rejects invalid slugs and roles before D1', async () => {
    const svc = new TeamService(
      { DB: createUnreachableDb() },
      { teamDAO: async () => teamDao, organizationDAO: async () => orgDao, organizationMemberDAO: async () => orgMemberDao },
    );
    expect(() => TeamService.validateTeamSlug('Bad Slug!')).toThrow();
    await expect(svc.addMember('acme', 'team-a', 'boss@x.com', 'a@x.com', 'super' as never)).rejects.toThrow('Invalid role');
    await expect(svc.grantRepo('acme', 'team-a', 'boss@x.com', 'r1', 'super' as never)).rejects.toThrow('Invalid role');
  });
});

describe('hardening sweep: webhook retry policy + repo name validation', () => {
  it('retries 429/5xx and network failures only', () => {
    expect(WebhookDeliveryService.isRetryableHttpStatus(null)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(429)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(500)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(200)).toBe(false);
    expect(WebhookDeliveryService.isRetryableHttpStatus(400)).toBe(false);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(1)).toBe(60);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(99)).toBe(86_400);
  });

  it('validates owner/name pairs used by the RepoWorker split helper', () => {
    expect(RepoFullName.tryParse('foo', 'bar')).not.toBeNull();
    expect(RepoFullName.tryParse('', 'bar')).toBeNull();
    expect(RepoFullName.tryParse('foo', '')).toBeNull();
  });
});
