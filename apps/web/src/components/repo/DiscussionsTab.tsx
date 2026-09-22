import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MessagesSquare } from 'lucide-react';
import { createDiscussion } from '../../services/discussionService';
import { formatTimestamp } from '../../lib/format';
import { readIntParam, readParam, writeParams } from '../../lib/urlParams';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Textarea } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { Markdown } from '../shared/Markdown';
import { useDiscussions } from './useDiscussions';
import { useDiscussionDetail } from './useDiscussionDetail';

export function DiscussionsTab({
  owner,
  repo,
  canWrite,
  showNotice,
  authorized,
}: {
  owner: string;
  repo: string;
  canWrite: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  authorized?: boolean | null;
}) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  // Category + open discussion are URL state (`?category=&discussion=`) with
  // the URL as the single source of truth: selection writes the query
  // directly, so pasted links, Back, and clicks can never disagree. Drafts
  // (title/body/comment) stay local by design.
  const category = readParam(params, 'category');
  const selectedRaw = readIntParam(params, 'discussion', -1, 1);
  const selected = selectedRaw < 0 ? null : selectedRaw;
  const setCategory = (next: string) => {
    writeParams(setParams, params, { category: next });
  };
  const setSelected = (next: number | null) => {
    writeParams(setParams, params, { discussion: next === null ? '' : String(next) });
  };
  const { categories, discussions, loading, reload } = useDiscussions({ owner, repo, category, authorized, showNotice });
  const detailHook = useDiscussionDetail({ owner, repo, selected, authorized, showNotice });
  const { detail } = detailHook;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  const signedIn = authorized === true;

  const selectDiscussion = (number: number | null) => {
    detailHook.clearDetail();
    setSelected(number);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { discussion } = await createDiscussion(owner, repo, {
        title: title.trim(),
        body: body.trim() || null,
        categorySlug: category || undefined,
      });
      setTitle('');
      setBody('');
      showNotice('success', t('discussions.discussionCreated', 'Discussion Created.'));
      reload();
      selectDiscussion(discussion.number);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToCreateDiscussion', 'Failed To Create Discussion.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {signedIn && (
        <Card>
          <CardHeader>
            <CardTitle>{t('discussions.newDiscussion', 'New Discussion')}</CardTitle>
          </CardHeader>
          <form onSubmit={submit} className="space-y-3">
            <Input
              placeholder={t('discussions.titlePlaceholder', 'Title')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
            <div className="flex gap-2">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm"
              >
                <option value="">{t('discussions.allCategories', 'All Categories')}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.slug}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
            <Textarea
              placeholder={t('discussions.bodyPlaceholder', 'Write Something…')}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
            />
            <Button type="submit" variant="primary" size="sm" loading={saving}>
              {t('discussions.createDiscussion', 'Create Discussion')}
            </Button>
          </form>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('discussions.discussions', 'Discussions')}</CardTitle>
          <RefreshButton onRefresh={reload} loading={loading} />
        </CardHeader>
        {!loading && discussions.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">
            <MessagesSquare className="h-6 w-6 mx-auto mb-3" />
            {t('discussions.noDiscussions', 'No Discussions Yet.')}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {discussions.map((d) => (
              <li key={d.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs rounded border border-[var(--color-border)] px-1.5 py-0.5">{d.status}</span>
                  <button
                    type="button"
                    onClick={() => selectDiscussion(d.number)}
                    className="font-medium text-[var(--color-accent)] hover:underline text-left"
                  >
                    {d.title}
                  </button>
                  <span className="text-xs text-[var(--color-text-muted)]">#{d.number}</span>
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {d.author} · {formatTimestamp(d.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {detail && (
        <Card>
          <CardHeader>
            <CardTitle>
              #{detail.discussion.number} {detail.discussion.title}
            </CardTitle>
            <div className="flex gap-2">
              {canWrite && detail.discussion.status === 'open' && (
                <>
                  <Button size="sm" onClick={() => detailHook.setStatus(detail.discussion.number, 'answered')}>
                    {t('discussions.markAnswered', 'Mark Answered')}
                  </Button>
                  <Button size="sm" onClick={() => detailHook.setStatus(detail.discussion.number, 'locked')}>
                    {t('discussions.lock', 'Lock')}
                  </Button>
                </>
              )}
              {canWrite && detail.discussion.status !== 'open' && (
                <Button size="sm" onClick={() => detailHook.setStatus(detail.discussion.number, 'open')}>
                  {t('discussions.reopen', 'Reopen')}
                </Button>
              )}
              {canWrite && (
                <Button
                  size="sm"
                  onClick={() =>
                    detailHook.removeDiscussion(detail.discussion.number).then(() => {
                      selectDiscussion(null);
                      reload();
                    })
                  }
                >
                  {t('common.delete', 'Delete')}
                </Button>
              )}
            </div>
          </CardHeader>
          {detail.discussion.body && <Markdown content={detail.discussion.body} />}
          <div className="mt-4 space-y-3">
            {detail.comments.map((c) => (
              <div key={c.id} className="rounded border border-[var(--color-border)] p-2 text-sm">
                <p className="text-xs text-[var(--color-text-muted)]">
                  {c.author} · {formatTimestamp(c.createdAt)}
                </p>
                <Markdown content={c.body} />
                {canWrite && (
                  <Button size="sm" onClick={() => detailHook.removeComment(detail.discussion.number, c.id)}>
                    {t('common.delete', 'Delete')}
                  </Button>
                )}
              </div>
            ))}
          </div>
          {signedIn && detail.discussion.status !== 'locked' && (
            <form onSubmit={detailHook.submitComment} className="mt-3 flex gap-2">
              <Input
                placeholder={t('discussions.replyPlaceholder', 'Write A Reply…')}
                value={detailHook.comment}
                onChange={(e) => detailHook.setComment(e.target.value)}
              />
              <Button type="submit" size="sm" variant="primary">
                {t('discussions.reply', 'Reply')}
              </Button>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
