import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CircleDot } from 'lucide-react';
import type { Issue } from '../../types';
import { createIssue, listIssues } from '../../services/issueService';
import { formatTimestamp } from '../../lib/format';
import { readParam, writeParams } from '../../lib/urlParams';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Textarea } from '../ui/Input';
import { IssueStatusBadge } from '../ui/Badge';
import { RefreshButton } from '../shared/RefreshButton';
import { Markdown } from '../shared/Markdown';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

function excerpt(body: string, max = 500): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max).trimEnd()}…`;
}

export function IssuesTab({
  owner,
  repo,
  canWrite,
  showNotice,
  onCountChange,
  authorized,
}: {
  owner: string;
  repo: string;
  canWrite: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onCountChange?: (count: number) => void;
  authorized?: boolean | null;
}) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);
  // Label filter is URL state (`?label=`) with the URL as the single source
  // of truth: typing writes the query directly, so pasted links, Back, and
  // keystrokes can never disagree. Drafts (title/body) stay local.
  const labelFilter = readParam(params, 'label');
  const setLabelFilter = (next: string) => {
    writeParams(setParams, params, { label: next.trim() });
  };

  useEffect(() => {
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        const list = await listIssues(owner, repo, { ...authOpt, label: labelFilter.trim() || undefined });
        setIssues(list);
        onCountChange?.(list.length);
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadIssues', 'Failed To Load Issues.'));
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [owner, repo, showNotice, onCountChange, reloadKey, t, authorized, labelFilter]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await createIssue(owner, repo, { title: title.trim(), body: body.trim() || undefined });
      setTitle('');
      setBody('');
      showNotice('success', t('issues.issueCreated', 'Issue Created.'));
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateIssue', 'Failed To Create Issue.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>{t('issues.newIssue', 'New Issue')}</CardTitle>
          </CardHeader>
          <form onSubmit={submit} className="space-y-3">
            <Input placeholder={t('issues.titlePlaceholder', 'Title')} value={title} onChange={(e) => setTitle(e.target.value)} required />
            <Textarea
              placeholder={t('issues.descriptionPlaceholder', 'Description (Optional)')}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
            />
            <Button type="submit" variant="primary" size="sm" loading={saving}>
              {t('issues.createIssue', 'Create Issue')}
            </Button>
          </form>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('issues.issues', 'Issues')}</CardTitle>
          <RefreshButton onRefresh={refresh} loading={loading} />
        </CardHeader>
        <div className="mb-3 flex gap-2">
          <Input
            placeholder={t('issues.filterByLabel', 'Filter By Label…')}
            value={labelFilter}
            onChange={(e) => setLabelFilter(e.target.value)}
          />
        </div>
        {!loading && issues.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">
            <CircleDot className="h-6 w-6 mx-auto mb-3" />
            {t('issues.noIssues', 'No Issues Yet.')}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {issues.map((i) => (
              <li key={i.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <IssueStatusBadge status={i.status} />
                  <Link to={`/${owner}/${repo}/issues/${i.number}`} className="font-medium text-[var(--color-accent)] hover:underline">
                    {i.title}
                  </Link>
                  <span className="text-xs text-[var(--color-text-muted)]">#{i.number}</span>
                </div>
                {i.body && (
                  <div className="mt-1 text-sm text-[var(--color-text-secondary)]">
                    <Markdown content={excerpt(i.body)} />
                  </div>
                )}
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {t('issues.openedBy', 'Opened By {{email}} · {{date}}', {
                    username: i.creator,
                    date: formatTimestamp(i.created_at),
                  })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
