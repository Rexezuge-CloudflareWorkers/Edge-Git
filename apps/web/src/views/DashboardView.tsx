import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookMarked, Plus } from 'lucide-react';
import type { Repo } from '../types';
import { listMyRepos } from '../services/repoService';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { VisibilityBadge } from '../components/ui/Badge';
import { ReadOnlyField } from '../components/shared/ReadOnlyField';
import { RefreshButton } from '../components/shared/RefreshButton';

export function DashboardView({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const run = async () => {
      try {
        setRepos(await listMyRepos());
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : 'Failed To Load Repositories.');
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [showNotice, reloadKey]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-4">
      <Card className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 py-4">
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Dashboard</h1>
        <div className="flex flex-wrap items-center gap-3">
          <RefreshButton onRefresh={refresh} loading={loading} />
          <Link to="/new">
            <Button variant="primary" size="sm">
              <Plus className="h-3.5 w-3.5" />
              New Repository
            </Button>
          </Link>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Clone</CardTitle>
        </CardHeader>
        <div className="space-y-3">
          <ReadOnlyField label="Clone Any Repository" value={`git clone ${globalThis.location?.origin ?? ''}/<owner>/<repo>`} showCopy />
          <p className="text-sm text-[var(--color-text-secondary)]">
            Authenticated push and private fetch use a personal access token as the password:{' '}
            <code className="font-mono text-xs">https://&lt;owner&gt;:&lt;PAT&gt;@host/owner/repo</code>. Public repos allow anonymous
            fetch.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Repositories</CardTitle>
          <span className="text-sm text-[var(--color-text-muted)]">{repos.length}</span>
        </CardHeader>
        {!loading && repos.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">
            <BookMarked className="h-6 w-6 mx-auto mb-3 text-[var(--color-text-muted)]" />
            No Repositories Yet. Create One To Get Started.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {repos.map((r) => (
              <li key={r.fullName} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <Link to={`/${r.owner}/${r.name}`} className="font-medium text-[var(--color-accent)] hover:underline truncate">
                    {r.fullName}
                  </Link>
                  {r.description && <p className="text-sm text-[var(--color-text-secondary)] truncate">{r.description}</p>}
                </div>
                <VisibilityBadge isPrivate={r.isPrivate} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
