import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PullReviewThread } from '../../types';
import { listPullThreads, openPullThread, replyPullThread, resolvePullThread } from '../../services/pullService';
import { countOpenThreads, groupThreadsByPath, threadLabel } from '../../lib/threads';
import { formatTimestamp } from '../../lib/format';
import { Markdown } from '../shared/Markdown';
import { Button } from '../ui/Button';
import { CardHeader, CardTitle } from '../ui/Card';
import { Input, Select, Textarea } from '../ui/Input';
import { Badge } from '../ui/Badge';

export function PullThreads({
  owner,
  repo,
  number,
  canWrite,
  showNotice,
  authorized,
  refreshKey,
}: {
  owner: string;
  repo: string;
  number: number;
  canWrite: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  authorized?: boolean | null;
  refreshKey?: number;
}) {
  const { t } = useTranslation();
  const [threads, setThreads] = useState<PullReviewThread[]>([]);
  const [path, setPath] = useState('');
  const [line, setLine] = useState('');
  const [side, setSide] = useState<'old' | 'new'>('new');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');

  const load = useCallback(async () => {
    try {
      setThreads(await listPullThreads(owner, repo, number, authorized === true ? { isAuthed: true } : { isAuthed: false }));
    } catch {
      // Threads are best-effort on legacy DBs without migration 0010.
      setThreads([]);
    }
  }, [owner, repo, number, authorized]);

  useEffect(() => {
    let cancelled = false;
    listPullThreads(owner, repo, number, authorized === true ? { isAuthed: true } : { isAuthed: false })
      .then((loaded) => {
        if (!cancelled) setThreads(loaded);
      })
      .catch(() => {
        if (!cancelled) setThreads([]);
      });
    return () => {
      cancelled = true;
    };
  }, [owner, repo, number, authorized, refreshKey]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim() || !body.trim()) return;
    const parsedLine = line.trim() === '' ? null : Number(line.trim());
    if (parsedLine !== null && (!Number.isSafeInteger(parsedLine) || parsedLine < 1)) {
      showNotice('error', t('pulls.invalidThreadLine', 'Line Must Be A Positive Integer.'));
      return;
    }
    setSaving(true);
    try {
      await openPullThread(owner, repo, number, { path: path.trim(), line: parsedLine, side, body: body.trim() });
      setPath('');
      setLine('');
      setBody('');
      await load();
      showNotice('success', t('pulls.threadOpened', 'Inline Comment Added.'));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToAddComment', 'Failed To Add Comment.'));
    } finally {
      setSaving(false);
    }
  };

  const submitReply = async (threadId: string) => {
    if (!replyBody.trim()) return;
    try {
      await replyPullThread(owner, repo, number, threadId, replyBody.trim());
      setReplyFor(null);
      setReplyBody('');
      await load();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToAddComment', 'Failed To Add Comment.'));
    }
  };

  const toggleResolve = async (thread: PullReviewThread) => {
    try {
      await resolvePullThread(owner, repo, number, thread.id, thread.status !== 'resolved');
      await load();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToUpdatePull', 'Failed To Update Pull Request.'));
    }
  };

  const open = countOpenThreads(threads);
  const groups = groupThreadsByPath(threads);

  return (
    <div>
      <CardHeader>
        <CardTitle>
          {t('pulls.inlineThreads', 'Inline Comments')} {threads.length > 0 && <span className="font-normal">({open} open)</span>}
        </CardTitle>
      </CardHeader>
      {threads.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t('pulls.noThreads', 'No Inline Comments Yet.')}</p>
      ) : (
        <ul className="space-y-3">
          {Array.from(groups, ([groupPath, group]) => (
            <li key={groupPath}>
              <p className="font-mono text-xs text-[var(--color-text-muted)]">{groupPath}</p>
              <ul className="mt-1 space-y-2">
                {group.map((thread) => (
                  <li key={thread.id} className="rounded-lg border border-[var(--color-border)] p-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={thread.status === 'resolved' ? 'success' : 'warning'}>
                        {thread.status === 'resolved' ? t('pulls.resolved', 'Resolved') : t('pulls.open', 'Open')}
                      </Badge>
                      <span className="font-mono text-xs text-[var(--color-text-muted)]">{threadLabel(thread)}</span>
                      <span className="text-xs text-[var(--color-text-muted)]">
                        {thread.author} · {formatTimestamp(thread.created_at)}
                      </span>
                      {canWrite && (
                        <button
                          type="button"
                          onClick={() => void toggleResolve(thread)}
                          className="ml-auto text-xs text-[var(--color-accent)] hover:underline"
                        >
                          {thread.status === 'resolved' ? t('pulls.reopenThread', 'Reopen') : t('pulls.resolveThread', 'Resolve')}
                        </button>
                      )}
                    </div>
                    <ul className="mt-2 space-y-2">
                      {thread.comments.map((comment) => (
                        <li key={comment.id}>
                          <p className="text-xs text-[var(--color-text-muted)]">
                            {comment.author} · {formatTimestamp(comment.created_at)}
                          </p>
                          <div className="mt-0.5 text-sm text-[var(--color-text-primary)]">
                            <Markdown content={comment.body} />
                          </div>
                        </li>
                      ))}
                    </ul>
                    {canWrite &&
                      (replyFor === thread.id ? (
                        <div className="mt-2 space-y-2">
                          <Textarea
                            placeholder={t('pulls.replyPlaceholder', 'Write A Reply…')}
                            value={replyBody}
                            onChange={(e) => setReplyBody(e.target.value)}
                            rows={2}
                          />
                          <div className="flex gap-2">
                            <Button type="button" variant="secondary" size="sm" onClick={() => void submitReply(thread.id)}>
                              {t('pulls.reply', 'Reply')}
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                setReplyFor(null);
                                setReplyBody('');
                              }}
                            >
                              {t('common.cancel', 'Cancel')}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setReplyFor(thread.id)}
                          className="mt-2 text-xs text-[var(--color-accent)] hover:underline"
                        >
                          {t('pulls.reply', 'Reply')}
                        </button>
                      ))}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={submit} className="mt-4 space-y-2">
          <div className="flex gap-2 flex-wrap">
            <Input
              placeholder={t('pulls.threadPathPlaceholder', 'File Path (e.g. src/app.ts)')}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              required
            />
            <Input
              placeholder={t('pulls.threadLinePlaceholder', 'Line (Optional)')}
              value={line}
              onChange={(e) => setLine(e.target.value)}
              inputMode="numeric"
            />
            <Select value={side} onChange={(e) => setSide(e.target.value as 'old' | 'new')} aria-label="Side">
              <option value="new">new</option>
              <option value="old">old</option>
            </Select>
          </div>
          <Textarea
            placeholder={t('pulls.threadBodyPlaceholder', 'Comment On This Line…')}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
          />
          <Button type="submit" variant="secondary" size="sm" loading={saving} disabled={!path.trim() || !body.trim()}>
            {t('pulls.addInlineComment', 'Add Inline Comment')}
          </Button>
        </form>
      )}
    </div>
  );
}
