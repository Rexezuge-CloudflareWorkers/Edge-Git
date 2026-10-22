import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '@rexezuge/d1';
import type { SubrequestMeter } from '@rexezuge/shared';

export interface PullReviewThreadRow {
  id: string;
  pull_request_id: string;
  path: string;
  line: number | null;
  side: string;
  commit_oid: string | null;
  status: string;
  author_email: string;
  created_at: number;
  resolved_by: string | null;
  resolved_at: number | null;
}

export interface PullThreadCommentRow {
  id: string;
  thread_id: string;
  author_email: string;
  body: string;
  created_at: number;
}

class PullThreadDAO extends BaseDAO {
  constructor(database: D1Queryable, meter?: SubrequestMeter) {
    super(database, meter);
  }

  public async openThread(input: {
    id: string;
    pullRequestId: string;
    path: string;
    line: number | null;
    side: 'old' | 'new';
    commitOid: string | null;
    authorEmail: string;
    now: number;
  }): Promise<void> {
    await this.run('INSERT INTO pull_review_threads (id, pull_request_id, path, line, side, commit_oid, status, author_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [input.id, input.pullRequestId, input.path, input.line, input.side, input.commitOid, 'open', input.authorEmail, input.now]);
  }

  public async listThreads(pullRequestId: string): Promise<PullReviewThreadRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM pull_review_threads WHERE pull_request_id = ? ORDER BY created_at ASC')
      .bind(pullRequestId)
      .all<PullReviewThreadRow>();
    return result.results ?? [];
  }

  public async getThread(pullRequestId: string, threadId: string): Promise<PullReviewThreadRow | null> {
    return this.database
      .prepare('SELECT * FROM pull_review_threads WHERE pull_request_id = ? AND id = ? LIMIT 1')
      .bind(pullRequestId, threadId)
      .first<PullReviewThreadRow>();
  }

  public async resolveThread(threadId: string, resolvedBy: string, resolved: boolean, now: number): Promise<void> {
    await this.run('UPDATE pull_review_threads SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?', [resolved ? 'resolved' : 'open', resolved ? resolvedBy : null, resolved ? now : null, threadId]);
  }

  public async addThreadComment(id: string, threadId: string, authorEmail: string, body: string, now: number): Promise<void> {
    await this.run('INSERT INTO pull_thread_comments (id, thread_id, author_email, body, created_at) VALUES (?, ?, ?, ?, ?)', [id, threadId, authorEmail, body, now]);
  }

  public async listThreadComments(threadId: string): Promise<PullThreadCommentRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM pull_thread_comments WHERE thread_id = ? ORDER BY created_at ASC')
      .bind(threadId)
      .all<PullThreadCommentRow>();
    return result.results ?? [];
  }

  public async deleteByRepo(repositoryId: string): Promise<void> {
    await this.run('DELETE FROM pull_thread_comments WHERE thread_id IN (SELECT id FROM pull_review_threads WHERE pull_request_id IN (SELECT id FROM pull_requests WHERE repository_id = ?))', [repositoryId]).catch(() => undefined);
    await this.run('DELETE FROM pull_review_threads WHERE pull_request_id IN (SELECT id FROM pull_requests WHERE repository_id = ?)', [repositoryId]).catch(() => undefined);
  }
}

export { PullThreadDAO };
