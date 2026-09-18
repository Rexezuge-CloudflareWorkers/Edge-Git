import { Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CurrentUser } from '../../types';
import Unauthorized from './Unauthorized';
import { Card } from '../ui/Card';
import { AppPage } from './AppPage';
import { LandingView } from '../../views/LandingView';
import { DashboardView } from '../../views/DashboardView';
import { NewRepoView } from '../../views/NewRepoView';
import { ProfileView } from '../../views/ProfileView';
import { RepoView } from '../../views/RepoView';
import { SearchView } from '../../views/SearchView';
import { CommitView } from '../../views/CommitView';
import { CompareView } from '../../views/CompareView';
import { CommitsView } from '../../views/CommitsView';
import { IssueDetailView } from '../../views/IssueDetailView';
import { PullDetailView } from '../../views/PullDetailView';
import { SettingsView } from '../../views/SettingsView';
import { SnippetsView } from '../../views/SnippetsView';
import { NotificationsView } from '../../views/NotificationsView';

interface SpaViewRouterProps {
  user: CurrentUser | null;
  setUser: (user: CurrentUser) => void;
  authorized: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
  defaultOwner: string;
  language: string;
  onLanguageChange: (lng: string) => void;
  languageDisabled?: boolean;
}

/**
 * Route switch extracted from `SpaApp` so the shell stays a thin composition
 * root. Props are the already-composed hook slices; no data fetching here.
 */
function SpaViewRouter({
  user,
  setUser,
  authorized,
  showNotice,
  defaultOwner,
  language,
  onLanguageChange,
  languageDisabled,
}: SpaViewRouterProps) {
  const { t } = useTranslation();
  // Auth is still resolving — repo routes render speculatively with public
  // data (see RepoView/useRepoData), but owner-gated routes stay on a
  // spinner to avoid flashing Landing/Unauthorized to signed-in users.
  if (authorized === null) {
    return (
      <Routes>
        <Route path="/:owner/:repo/issues/:number" element={<IssueDetailView authorized={authorized} showNotice={showNotice} />} />
        <Route path="/search" element={<SearchView showNotice={showNotice} />} />
        <Route path="/snippets" element={<SnippetsView showNotice={showNotice} authorized={authorized} />} />
        <Route path="/:owner/:repo/pulls/:number" element={<PullDetailView authorized={authorized} showNotice={showNotice} />} />
        <Route path="/:owner/:repo/commit/:oid" element={<CommitView authorized={authorized} showNotice={showNotice} />} />
        <Route path="/:owner/:repo/compare" element={<CompareView authorized={authorized} showNotice={showNotice} />} />
        <Route path="/:owner/:repo/commits" element={<CommitsView authorized={authorized} showNotice={showNotice} />} />
        <Route path="/:owner/:repo" element={<RepoView authorized={authorized} showNotice={showNotice} defaultOwner={defaultOwner} />} />
        <Route path="/:username" element={<ProfileView showNotice={showNotice} />} />
        <Route
          path="/notifications"
          element={
            <div className="min-h-screen bg-[var(--color-surface-base)] flex items-center justify-center">
              <div className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
            </div>
          }
        />
        <Route
          path="*"
          element={
            <div className="min-h-screen bg-[var(--color-surface-base)] flex items-center justify-center">
              <div className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
            </div>
          }
        />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/" element={user ? <DashboardView showNotice={showNotice} /> : <LandingView />} />
      <Route
        path="/new"
        element={
          user ? (
            <NewRepoView defaultOwner={defaultOwner} showNotice={showNotice} />
          ) : (
            <AppPage>
              <Unauthorized message={t('errors.signInToCreate', 'Sign In To Create Repositories.')} />
            </AppPage>
          )
        }
      />
      <Route path="/:owner/:repo/issues/:number" element={<IssueDetailView authorized={authorized} showNotice={showNotice} />} />
      <Route path="/search" element={<SearchView showNotice={showNotice} />} />
      <Route path="/snippets" element={<SnippetsView showNotice={showNotice} authorized={authorized} />} />
      <Route path="/:owner/:repo/pulls/:number" element={<PullDetailView authorized={authorized} showNotice={showNotice} />} />
      <Route path="/:owner/:repo/commit/:oid" element={<CommitView authorized={authorized} showNotice={showNotice} />} />
      <Route path="/:owner/:repo/compare" element={<CompareView authorized={authorized} showNotice={showNotice} />} />
      <Route path="/:owner/:repo/commits" element={<CommitsView authorized={authorized} showNotice={showNotice} />} />
      <Route path="/:owner/:repo" element={<RepoView authorized={authorized} showNotice={showNotice} defaultOwner={defaultOwner} />} />
      <Route path="/:username" element={<ProfileView showNotice={showNotice} />} />
      <Route
        path="/settings"
        element={
          user ? (
            <SettingsView
              user={user}
              setUser={setUser}
              showNotice={showNotice}
              language={language}
              onLanguageChange={onLanguageChange}
              languageDisabled={languageDisabled}
            />
          ) : (
            <AppPage>
              <Unauthorized message={t('errors.signInToManage', 'Sign In To Manage Settings.')} />
            </AppPage>
          )
        }
      />
      <Route
        path="/notifications"
        element={
          user ? (
            <NotificationsView showNotice={showNotice} />
          ) : (
            <AppPage>
              <Unauthorized message={t('errors.signInToManage', 'Sign In To Manage Settings.')} />
            </AppPage>
          )
        }
      />
      <Route
        path="*"
        element={
          <AppPage>
            <Card>
              <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('errors.pageNotFound', 'Page Not Found')}</h1>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                {t('errors.pageNotFoundDescription', 'The Page You Requested Does Not Exist.')}
              </p>
            </Card>
          </AppPage>
        }
      />
    </Routes>
  );
}

export { SpaViewRouter };
export type { SpaViewRouterProps };
