import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BookMarked, ChevronDown, Plus } from 'lucide-react';
import type { Repo } from '../types';
import { toLocalizedErrorMessage } from '../lib/backendErrors';
import { listMyRepos } from '../services/repoService';
import { listWatchedRepos } from '../services/socialService';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { AppPage } from '../components/layout/AppPage';
import { PageHeaderCard } from '../components/layout/PageHeaderCard';
import { EmptyState } from '../components/layout/PageState';
import { VisibilityBadge } from '../components/ui/Badge';
import { ReadOnlyField } from '../components/shared/ReadOnlyField';
import { RefreshButton } from '../components/shared/RefreshButton';
import { OrgCreateModal } from '../components/org/OrgCreateModal';

export function DashboardView({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [watched, setWatched] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [orgModal, setOrgModal] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const run = async () => {
      try {
        const mine = await listMyRepos();
        let watching: Repo[] = [];
        try {
          watching = await listWatchedRepos();
        } catch {
          watching = [];
        }
        const mineNames = new Set(mine.map((m) => m.fullName));
        setRepos(mine);
        setWatched(watching.filter((w) => !mineNames.has(w.fullName)));
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadRepositories', 'Failed To Load Repositories.'));
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

  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!newOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setNewOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [newOpen]);

  return (
    <AppPage>
      <PageHeaderCard
        title={t('dashboard.title', 'Dashboard')}
        actions={
          <>
            <RefreshButton onRefresh={refresh} loading={loading} />
            <div className="relative" ref={menuRef}>
              <Button variant="primary" size="sm" onClick={() => setNewOpen((v) => !v)} aria-haspopup="menu" aria-expanded={newOpen}>
                <Plus className="h-3.5 w-3.5" />
                {t('dashboard.new', 'New')}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
              {newOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-2 w-52 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] p-1.5 shadow-xl z-30"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
                    onClick={() => {
                      setNewOpen(false);
                      void navigate('/new');
                    }}
                  >
                    {t('dashboard.newRepository', 'New Repository')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="w-full text-left px-3 py-2 rounded-lg text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-3)]"
                    onClick={() => {
                      setNewOpen(false);
                      setOrgModal(true);
                    }}
                  >
                    {t('orgs.newOrg', 'New Organization')}
                  </button>
                </div>
              )}
            </div>
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.clone', 'Clone')}</CardTitle>
        </CardHeader>
        <div className="space-y-3">
          <ReadOnlyField label={t('dashboard.cloneAnyRepository', 'Clone Any Repository')} value={`git clone ${globalThis.location?.origin ?? ''}/<owner>/<repo>`} showCopy />
          <p className="text-sm text-[var(--color-text-secondary)]">
            {t('dashboard.cloneHelp', 'Authenticated Push And Private Fetch Use A Personal Access Token As The Password: {{example}}. Public Repos Allow Anonymous Fetch. Manage Tokens In Settings.', {
              example: 'https://<owner>:<PAT>@host/owner/repo',
            })}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.repositories', 'Repositories')}</CardTitle>
          <span className="text-sm text-[var(--color-text-muted)]">{repos.length}</span>
        </CardHeader>
        {!loading && repos.length === 0 ? (
          <EmptyState
            icon={<BookMarked className="h-6 w-6 text-[var(--color-text-muted)]" />}
            message={t('dashboard.empty', 'No Repositories Yet. Create One To Get Started.')}
          />
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
      {watched.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.watched', 'Watched Repositories')}</CardTitle>
            <span className="text-sm text-[var(--color-text-muted)]">{watched.length}</span>
          </CardHeader>
          <ul className="divide-y divide-[var(--color-border)]">
            {watched.map((r) => (
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
        </Card>
      )}
      {orgModal && (
        <OrgCreateModal
          showNotice={showNotice}
          onClose={() => setOrgModal(false)}
          onCreated={(username) => {
            setOrgModal(false);
            void navigate(`/${username}`);
          }}
        />
      )}
    </AppPage>
  );
}
