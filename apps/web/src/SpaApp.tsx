import { Route, Routes } from 'react-router-dom';
import { Header } from './components/layout/Header';
import { NoticeBar } from './components/layout/NoticeBar';
import Unauthorized from './components/layout/Unauthorized';
import { Card } from './components/ui/Card';
import { useNotice } from './hooks/useNotice';
import { useCurrentUser } from './hooks/useCurrentUser';
import { LandingView } from './views/LandingView';
import { DashboardView } from './views/DashboardView';
import { NewRepoView } from './views/NewRepoView';
import { RepoView } from './views/RepoView';

export default function SpaApp() {
  const { notice, showNotice } = useNotice();
  const { user, authorized } = useCurrentUser();

  if (authorized === null) {
    return (
      <div className="min-h-screen bg-[var(--color-surface-base)] flex items-center justify-center">
        <div className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
      </div>
    );
  }

  const defaultOwner = user ? user.email.split('@', 1)[0] : '';

  return (
    <div className="min-h-screen bg-[var(--color-surface-base)] text-[var(--color-text-primary)]">
      <Header userEmail={user?.email ?? null} />
      {notice && <NoticeBar notice={notice} />}

      <Routes>
        <Route path="/" element={user ? <DashboardView showNotice={showNotice} /> : <LandingView />} />
        <Route
          path="/new"
          element={
            user ? (
              <NewRepoView defaultOwner={defaultOwner} showNotice={showNotice} />
            ) : (
              <div className="max-w-7xl mx-auto px-6 py-8">
                <Unauthorized message="Sign In To Create Repositories." />
              </div>
            )
          }
        />
        <Route path="/:owner/:repo" element={<RepoView authorized={authorized} showNotice={showNotice} />} />
        <Route
          path="*"
          element={
            <div className="max-w-7xl mx-auto px-6 py-8">
              <Card>
                <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Page Not Found</h1>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">The page you requested does not exist.</p>
              </Card>
            </div>
          }
        />
      </Routes>
    </div>
  );
}
