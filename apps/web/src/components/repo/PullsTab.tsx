import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GitPullRequest } from 'lucide-react';
import type { PullRequest } from '../../types';
import { createPull, listPulls } from '../../services/pullService';
import { loadBranches } from '../../services/repoService';
import { formatTimestamp } from '../../lib/format';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Select, Textarea } from '../ui/Input';
import { PullStatusBadge } from '../ui/Badge';
import { RefreshButton } from '../shared/RefreshButton';
import { Markdown } from '../shared/Markdown';

export function PullsTab({
  owner,
  repo,
  canWrite,
  showNotice,
  onCountChange,
}: {
  owner: string;
  repo: string;
  canWrite: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onCountChange?: (count: number) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const [list, b] = await Promise.all([listPulls(owner, repo), loadBranches(owner, repo).catch(() => ({ branches: [], currentBranch: null }))]);
        if (cancelled) return;
        setPulls(list);
        setBranches(b.branches);
        setBase((prev) => prev || b.currentBranch || b.branches[0] || '');
      } catch (error) {
        if (!cancelled) showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadPulls', 'Failed To Load Pull Requests.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, reloadKey]);

  useEffect(() => {
    onCountChange?.(pulls.length);
  }, [pulls.length, onCountChange]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const headBranch = head || branches.find((b) => b !== base) || '';
    if (!base || !headBranch) {
      showNotice('error', t('errors.failedToCreatePull', 'Failed To Create Pull Request.'));
      return;
    }
    if (base === headBranch) {
      showNotice('error', t('pulls.sameBranch', 'Base And Head Must Differ.'));
      return;
    }
    setSaving(true);
    try {
      const created = await createPull(owner, repo, { title: title.trim(), body: body.trim() || undefined, baseBranch: base, headBranch });
      setTitle('');
      setBody('');
      showNotice('success', t('pulls.pullCreated', 'Pull Request Created.'));
      await navigate(`/${owner}/${repo}/pulls/${created.number}`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToCreatePull', 'Failed To Create Pull Request.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {canWrite && branches.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('pulls.newPull', 'New Pull Request')}</CardTitle>
          </CardHeader>
          <form onSubmit={submit} className="space-y-3">
            <Input placeholder={t('pulls.titlePlaceholder', 'Title')} value={title} onChange={(e) => setTitle(e.target.value)} required />
            <div className="flex gap-3 flex-wrap">
              <label className="flex-1 min-w-36 text-sm">
                <span className="text-[var(--color-text-muted)]">{t('pulls.base', 'Base')}</span>
                <Select value={base} onChange={(e) => setBase(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex-1 min-w-36 text-sm">
                <span className="text-[var(--color-text-muted)]">{t('pulls.head', 'Head')}</span>
                <Select value={head} onChange={(e) => setHead(e.target.value)}>
                  <option value="">{t('pulls.selectHead', 'Select Head')}</option>
                  {branches.filter((b) => b !== base).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <Textarea placeholder={t('pulls.descriptionPlaceholder', 'Description (Optional)')} value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
            <Button type="submit" variant="primary" size="sm" loading={saving}>
              {t('pulls.createPull', 'Create Pull Request')}
            </Button>
          </form>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('pulls.pulls', 'Pull Requests')}</CardTitle>
          <RefreshButton onRefresh={refresh} loading={loading} />
        </CardHeader>
        {!loading && pulls.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">
            <GitPullRequest className="h-6 w-6 mx-auto mb-3" />
            {t('pulls.noPulls', 'No Pull Requests Yet.')}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {pulls.map((p) => (
              <li key={p.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <PullStatusBadge status={p.status} />
                  <Link to={`/${owner}/${repo}/pulls/${p.number}`} className="font-medium text-[var(--color-accent)] hover:underline">
                    {p.title}
                  </Link>
                  <span className="text-xs text-[var(--color-text-muted)]">#{p.number}</span>
                  <span className="text-xs text-[var(--color-text-muted)] font-mono">
                    {p.base_branch} ← {p.head_branch}
                  </span>
                </div>
                {p.body && (
                  <div className="mt-1 text-sm text-[var(--color-text-secondary)]">
                    <Markdown content={p.body.length > 500 ? `${p.body.slice(0, 500).trimEnd()}…` : p.body} />
                  </div>
                )}
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {t('pulls.openedBy', 'Opened By {{email}} · {{date}}', {
                    email: p.creator_email,
                    date: formatTimestamp(p.created_at),
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
