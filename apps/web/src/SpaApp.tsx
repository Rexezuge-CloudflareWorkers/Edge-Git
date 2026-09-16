import { useMatch } from 'react-router-dom';
import { Header } from './components/layout/Header';
import { NoticeBar } from './components/layout/NoticeBar';
import { SpaViewRouter } from './components/layout/SpaViewRouter';
import { useNotice } from './hooks/useNotice';
import { useCurrentUser } from './hooks/useCurrentUser';
import { useSpaLanguage } from './hooks/useSpaLanguage';

function TopHeader({
  userEmail,
  username,
  language,
  onLanguageChange,
  languageDisabled,
}: {
  userEmail: string | null;
  username?: string | null;
  language: string;
  onLanguageChange: (lng: string) => void;
  languageDisabled: boolean;
}) {
  const isRepoPage = useMatch('/:owner/:repo') !== null;
  if (isRepoPage) return null;
  return (
    <Header
      userEmail={userEmail}
      username={username}
      language={language}
      onLanguageChange={onLanguageChange}
      languageDisabled={languageDisabled}
    />
  );
}

export default function SpaApp() {
  const { notice, showNotice } = useNotice();
  const { user, setUser, authorized } = useCurrentUser();
  const { language, languageStatus, languagePending, handleLanguageChange } = useSpaLanguage({
    user,
    showNotice,
    setUser,
  });

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
      <TopHeader
        userEmail={user?.email ?? null}
        username={user?.username ?? null}
        language={languageStatus === 'error' ? 'unknown' : language}
        onLanguageChange={handleLanguageChange}
        languageDisabled={languagePending || languageStatus !== 'ready'}
      />
      {notice && <NoticeBar notice={notice} />}

      <SpaViewRouter user={user} authorized={authorized} showNotice={showNotice} defaultOwner={defaultOwner} />
    </div>
  );
}
