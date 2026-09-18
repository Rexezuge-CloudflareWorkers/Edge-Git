import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '../components/ui/Card';
import { ContextBar } from '../components/layout/ContextBar';
import { SegmentedTabs } from '../components/layout/SegmentedTabs';
import { AppPage } from '../components/layout/AppPage';
import { searchCode, searchDiscussions, searchIssues, searchPulls, searchRepos, searchSnippets } from '../services/searchService';
import type { CodeHit } from '../services/searchService';
import type { Discussion, Issue, PullRequest, Repo, Snippet } from '../types';

type SearchTab = 'repos' | 'issues' | 'pulls' | 'code' | 'discussions' | 'snippets';

function parseTab(raw: string | null): SearchTab {
  const tabs: SearchTab[] = ['repos', 'issues', 'pulls', 'code', 'discussions', 'snippets'];
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
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
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
    setDiscussions([]);
    setSnippets([]);
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
            : type === 'discussions'
              ? searchDiscussions(query, 20).then(setDiscussions)
              : type === 'snippets'
                ? searchSnippets(query, 20).then(setSnippets)
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

  const searchTabs: Array<{ id: SearchTab; label: string }> = [
    { id: 'repos', label: t('search.repos', 'Repositories') },
    { id: 'issues', label: t('search.issues', 'Issues') },
    { id: 'pulls', label: t('search.pulls', 'Pull Requests') },
    { id: 'code', label: t('search.code', 'Code') },
    { id: 'discussions', label: t('search.discussions', 'Discussions') },
    { id: 'snippets', label: t('search.snippets', 'Snippets') },
  ];

  return (
    <div>
      <ContextBar
        crumb={
          <span className="text-xl font-semibold text-[var(--color-text-primary)] truncate">
            {t('search.title', 'Search')}
            {query && <span className="ml-2 text-sm font-normal text-[var(--color-text-muted)]">“{query}”</span>}
          </span>
        }
      />
      <AppPage>
        <SegmentedTabs ariaLabel="Search categories" tabs={searchTabs} value={type} onChange={(id) => switchTab(id as SearchTab)} />
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
        ) : type === 'discussions' ? (
          <div className="grid gap-3">
            {discussions.length === 0 ? (
              <Card>
                <p className="text-sm text-[var(--color-text-secondary)]">{t('search.noDiscussions', 'No Discussions Found.')}</p>
              </Card>
            ) : (
              discussions.map((d) => (
                <Card key={d.id}>
                  <p className="font-semibold text-[var(--color-accent)]">{d.title}</p>
                  {d.body ? <p className="mt-1 text-sm text-[var(--color-text-secondary)] line-clamp-2">{d.body}</p> : null}
                </Card>
              ))
            )}
          </div>
        ) : type === 'snippets' ? (
          <div className="grid gap-3">
            {snippets.length === 0 ? (
              <Card>
                <p className="text-sm text-[var(--color-text-secondary)]">{t('search.noSnippets', 'No Snippets Found.')}</p>
              </Card>
            ) : (
              snippets.map((s) => (
                <Card key={s.id}>
                  <Link to="/snippets" className="font-semibold text-[var(--color-accent)]">
                    {s.title || s.id.slice(0, 8)}
                  </Link>
                  <p className="mt-1 text-xs text-[var(--color-text-secondary)]">{s.ownerEmail}</p>
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
      </AppPage>
    </div>
  );
}
