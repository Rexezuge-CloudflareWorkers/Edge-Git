import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GitPullRequest } from 'lucide-react';
import type { PullRequest, Repo } from '../../types';
import { createPull, listPulls } from '../../services/pullService';
import { loadBranches } from '../../services/repoService';
import { listForks } from '../../services/forkService';
import { formatTimestamp } from '../../lib/format';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Select, Textarea } from '../ui/Input';
import { PullStatusBadge } from '../ui/Badge';
import { RefreshButton } from '../shared/RefreshButton';
import { Markdown } from '../shared/Markdown';

export function headLabel(pull: PullRequest): string {
  return pull.head_full_name && pull.head_full_name.toLowerCase() !== pull.full_name.toLowerCase()
    ? `${pull.head_full_name}:${pull.head_branch}`
    : pull.head_branch;
}

function sameRepoName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function mergeHeadRepoOptions(currentFull: string, parent: string | null | undefined, forks: Repo[], prev: string): { options: string[]; selected: string } {
  const options = [currentFull];
  if (parent && options.every((o) => !sameRepoName(o, parent))) {
    options.push(parent);
  }
  for (const f of forks) {
    if (options.every((o) => !sameRepoName(o, f.fullName))) options.push(f.fullName);
  }
  return { options, selected: options.some((o) => sameRepoName(o, prev)) ? prev : currentFull };
}

export function PullsTab({
  owner,
  repo,
  repoMeta,
  canWrite,
  showNotice,
  onCountChange,
  authorized,
}: {
  owner: string;
  repo: string;
  repoMeta?: Repo | null;
  canWrite: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onCountChange?: (count: number) => void;
  authorized?: boolean | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currentFull = `${owner}/${repo}`;
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [branches, setBranches] = useState<string[]>([]);
  const [headRepos, setHeadRepos] = useState<string[]>([currentFull]);
  const [headRepo, setHeadRepo] = useState(currentFull);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [crossBranches, setCrossBranches] = useState<string[]>([]);
  const [labelFilter, setLabelFilter] = useState('');
  const [isDraft, setIsDraft] = useState(false);

  const isCrossRepo = headRepo.toLowerCase() !== currentFull.toLowerCase();
  const headBranches = isCrossRepo ? crossBranches : branches;

  useEffect(() => {
    let cancelled = false;
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        const [list, b, forks] = await Promise.all([
          listPulls(owner, repo, { ...authOpt, label: labelFilter.trim() || undefined }),
          loadBranches(owner, repo, authOpt).catch(() => ({ branches: [], currentBranch: null })),
          listForks(owner, repo, authOpt).catch(() => ({ forks: [], count: 0 })),
        ]);
        if (cancelled) return;
        setPulls(list);
        setBranches(b.branches);
        setBase((prev) => prev || b.currentBranch || b.branches[0] || '');
        const merged = mergeHeadRepoOptions(currentFull, repoMeta?.forkedFrom, forks.forks, headRepo);
        setHeadRepos(merged.options);
        setHeadRepo(merged.selected);
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
  }, [owner, repo, reloadKey, authorized, labelFilter]);

  useEffect(() => {
    if (!isCrossRepo) return;
    const slash = headRepo.indexOf('/');
    if (slash <= 0) return;
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    let cancelled = false;
    const run = async () => {
      try {
        const b = await loadBranches(headRepo.slice(0, slash), headRepo.slice(slash + 1), authOpt);
        if (!cancelled) setCrossBranches(b.branches);
      } catch {
        if (!cancelled) setCrossBranches([]);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headRepo, isCrossRepo, authorized]);

  useEffect(() => {
    onCountChange?.(pulls.length);
  }, [pulls.length, onCountChange]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const headBranch = head || headBranches.find((b) => (isCrossRepo ? true : b !== base)) || '';
    if (!base || !headBranch) {
      showNotice('error', t('errors.failedToCreatePull', 'Failed To Create Pull Request.'));
      return;
    }
    if (!isCrossRepo && base === headBranch) {
      showNotice('error', t('pulls.sameBranch', 'Base And Head Must Differ.'));
      return;
    }
    setSaving(true);
    try {
      const slash = headRepo.indexOf('/');
      const created = await createPull(owner, repo, {
        title: title.trim(),
        body: body.trim() || undefined,
        baseBranch: base,
        headBranch,
        ...(isCrossRepo && slash > 0 && { headOwner: headRepo.slice(0, slash), headRepo: headRepo.slice(slash + 1) }),
        ...(isDraft && { isDraft: true }),
      });
      setTitle('');
      setBody('');
      setIsDraft(false);
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
      {canWrite && (branches.length >= 2 || (isCrossRepo && branches.length > 0 && headBranches.length > 0)) && (
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
                <span className="text-[var(--color-text-muted)]">{t('pulls.headRepo', 'Head Repository')}</span>
                <Select value={headRepo} onChange={(e) => { setHeadRepo(e.target.value); setHead(''); }}>
                  {headRepos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex-1 min-w-36 text-sm">
                <span className="text-[var(--color-text-muted)]">{t('pulls.head', 'Head')}</span>
                <Select value={head} onChange={(e) => setHead(e.target.value)}>
                  <option value="">{t('pulls.selectHead', 'Select Head')}</option>
                  {headBranches.filter((b) => isCrossRepo || b !== base).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <Textarea placeholder={t('pulls.descriptionPlaceholder', 'Description (Optional)')} value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
              <input type="checkbox" checked={isDraft} onChange={(e) => setIsDraft(e.target.checked)} />
              {t('pulls.draft', 'Draft Pull Request')}
            </label>
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
        <div className="mb-3 flex gap-2">
          <Input placeholder={t('pulls.filterByLabel', 'Filter By Label…')} value={labelFilter} onChange={(e) => setLabelFilter(e.target.value)} />
        </div>
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
                    {p.base_branch} ← {headLabel(p)}
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
