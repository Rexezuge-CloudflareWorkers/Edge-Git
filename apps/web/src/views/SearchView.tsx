import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '../components/ui/Card';
import { searchIssues, searchRepos } from '../services/searchService';
import type { Issue, Repo } from '../types';

export function SearchView({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const query = (params.get('q') ?? '').trim();
  const type = params.get('type') === 'issues' ? 'issues' : 'repos';
  const [repos, setRepos] = useState<Repo[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (query.length < 2) {
      setRepos([]);
      setIssues([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const run = type === 'issues' ? searchIssues(query, 20).then(setIssues) : searchRepos(query, 20).then(setRepos);
    run
      .catch(() => {
        if (!cancelled) showNotice('error', t('errors.failedToSearch', 'Failed To Load Search Results.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, type, showNotice, t]);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-center gap-2 mb-4">
        <button
          type="button"
          onClick={() => setParams(query ? { q: query, type: 'repos' } : { type: 'repos' })}
          className={type === 'repos' ? 'font-semibold' : ''}
        >
          {t('search.repos', 'Repositories')}
        </button>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => setParams(query ? { q: query, type: 'issues' } : { type: 'issues' })}
          className={type === 'issues' ? 'font-semibold' : ''}
        >
          {t('search.issues', 'Issues')}
        </button>
      </div>
      {loading ? (
        <p className="text-sm text-[var(--color-text-secondary)]">{t('common.loading', 'Loading…')}</p>
      ) : query.length < 2 ? (
        <Card>
          <p className="text-sm text-[var(--color-text-secondary)]">{t('search.hint', 'Type At Least 2 Characters To Search.')}</p>
        </Card>
      ) : type === 'repos' ? (
        <div className="grid gap-3">
          {repos.length === 0 ? (
            <Card>
              <p className="text-sm text-[var(--color-text-secondary)]">{t('search.noRepos', 'No Repositories Found.')}</p>
            </Card>
          ) : (
            repos.map((r) => (
              <Card key={r.id}>
                <Link to={`/${r.owner}/${r.name}`} className="font-semibold text-[var(--color-accent)]">
                  {r.fullName}
                </Link>
                {r.description ? <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{r.description}</p> : null}
              </Card>
            ))
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          {issues.length === 0 ? (
            <Card>
              <p className="text-sm text-[var(--color-text-secondary)]">{t('search.noIssues', 'No Issues Found.')}</p>
            </Card>
          ) : (
            issues.map((i) => (
              <Card key={i.id}>
                <Link to={`/${i.full_name}/issues/${i.number}`} className="font-semibold text-[var(--color-accent)]">
                  {i.full_name}#{i.number} — {i.title}
                </Link>
                {i.body ? <p className="mt-1 text-sm text-[var(--color-text-secondary)] line-clamp-2">{i.body}</p> : null}
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
