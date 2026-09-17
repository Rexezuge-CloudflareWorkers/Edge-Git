import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '../components/ui/Card';
import { searchCode, searchIssues, searchPulls, searchRepos } from '../services/searchService';
import type { CodeHit } from '../services/searchService';
import type { Issue, PullRequest, Repo } from '../types';

type SearchTab = 'repos' | 'issues' | 'pulls' | 'code';

function parseTab(raw: string | null): SearchTab {
  const tabs: SearchTab[] = ['repos', 'issues', 'pulls', 'code'];
  return raw !== null && tabs.includes(raw as SearchTab) ? (raw as SearchTab) : 'repos';
}

export function SearchView({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const query = (params.get('q') ?? '').trim();
  const type = parseTab(params.get('type'));
  const [repos, setRepos] = useState<Repo[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [pulls, setPulls] = useState<PullRequest[]>([]);
  const [code, setCode] = useState<CodeHit[]>([]);
  const [loading, setLoading] = useState(query.length >= 2);
  // Clear stale hits when the query changes (render-phase adjustment avoids
  // set-state-in-effect while keeping old results from flashing).
  const [lastKey, setLastKey] = useState(`${type}:${query}`);
  if (lastKey !== `${type}:${query}`) {
    setLastKey(`${type}:${query}`);
    setRepos([]);
    setIssues([]);
    setPulls([]);
    setCode([]);
    setLoading(true);
  }

  useEffect(() => {
    if (query.length < 2) return;
    let cancelled = false;
    const run =
      type === 'issues'
        ? searchIssues(query, 20).then(setIssues)
        : type === 'pulls'
          ? searchPulls(query, 20).then(setPulls)
          : type === 'code'
            ? searchCode(query, 20).then(setCode)
            : searchRepos(query, 20).then(setRepos);
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

  const switchTab = (tab: SearchTab): void => {
    setParams(query ? { q: query, type: tab } : { type: tab });
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-center gap-2 mb-4">
        <button type="button" onClick={() => switchTab('repos')} className={type === 'repos' ? 'font-semibold' : ''}>
          {t('search.repos', 'Repositories')}
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={() => switchTab('issues')} className={type === 'issues' ? 'font-semibold' : ''}>
          {t('search.issues', 'Issues')}
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={() => switchTab('pulls')} className={type === 'pulls' ? 'font-semibold' : ''}>
          {t('search.pulls', 'Pull Requests')}
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={() => switchTab('code')} className={type === 'code' ? 'font-semibold' : ''}>
          {t('search.code', 'Code')}
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
      ) : type === 'issues' ? (
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
      ) : type === 'pulls' ? (
        <div className="grid gap-3">
          {pulls.length === 0 ? (
            <Card>
              <p className="text-sm text-[var(--color-text-secondary)]">{t('search.noPulls', 'No Pull Requests Found.')}</p>
            </Card>
          ) : (
            pulls.map((p) => (
              <Card key={p.id}>
                <Link to={`/${p.full_name}/pulls/${p.number}`} className="font-semibold text-[var(--color-accent)]">
                  {p.full_name}#{p.number} — {p.title}
                </Link>
                {p.body ? <p className="mt-1 text-sm text-[var(--color-text-secondary)] line-clamp-2">{p.body}</p> : null}
              </Card>
            ))
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          {code.length === 0 ? (
            <Card>
              <p className="text-sm text-[var(--color-text-secondary)]">{t('search.noCode', 'No Code Matches Found.')}</p>
            </Card>
          ) : (
            code.map((hit) => (
              <Card key={`${hit.repo_id}:${hit.path}`}>
                <p className="font-mono text-sm text-[var(--color-accent)]">{hit.path}</p>
                <pre className="mt-1 text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap break-words">{hit.snippet}</pre>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}
