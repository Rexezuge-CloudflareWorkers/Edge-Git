import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitBranch, Plus } from 'lucide-react';
import { cn } from '../../lib/utils';
import { LanguageSelector } from '../shared/LanguageSelector';

export function Header({
  userEmail,
  username,
  language,
  onLanguageChange,
  languageDisabled,
}: {
  userEmail: string | null;
  username?: string | null;
  language?: string;
  onLanguageChange?: (lng: string) => void;
  languageDisabled?: boolean;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-surface-base)]/95 backdrop-blur">
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-5">
          <Link to="/" className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <GitBranch className="h-5 w-5 text-[var(--color-accent)]" />
            <span>
              <span className="text-[var(--color-accent)]">Edge</span>
              <span className="text-[var(--color-text-primary)]">-Git</span>
            </span>
          </Link>

          <form
            role="search"
            className="hidden md:block"
            onSubmit={(e) => {
              e.preventDefault();
              if (search.trim()) void navigate(`/search?q=${encodeURIComponent(search.trim())}`);
            }}
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('search.placeholder', 'Search Repositories And Issues…')}
              aria-label={t('search.placeholder', 'Search Repositories And Issues…')}
              className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm"
            />
          </form>

          {userEmail && (
            <nav className="flex items-center rounded-lg bg-[var(--color-surface-2)] p-1 gap-0.5">
              <button
                type="button"
                onClick={() => navigate('/')}
                className={cn(
                  'px-3.5 py-1.5 rounded-md text-sm transition-colors duration-150',
                  'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                )}
              >
                {t('header.dashboard', 'Dashboard')}
              </button>
              <button
                type="button"
                onClick={() => navigate('/new')}
                className={cn(
                  'px-3.5 py-1.5 rounded-md text-sm transition-colors duration-150 inline-flex items-center gap-1',
                  'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                )}
              >
                <Plus className="h-3.5 w-3.5" />
                {t('header.new', 'New')}
              </button>
              <button
                type="button"
                onClick={() => navigate('/settings')}
                className={cn(
                  'px-3.5 py-1.5 rounded-md text-sm transition-colors duration-150',
                  'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                )}
              >
                {t('header.settings', 'Settings')}
              </button>
            </nav>
          )}
        </div>

        <div className="flex items-center gap-3">
          {onLanguageChange && (
            <LanguageSelector value={language} onChange={onLanguageChange} disabled={languageDisabled} />
          )}
          {username ? (
            <Link to={`/${username}`} className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-accent)] truncate max-w-xs">
              {userEmail ?? ''}
            </Link>
          ) : (
            <div className="text-sm text-[var(--color-text-muted)] truncate max-w-xs">{userEmail ?? ''}</div>
          )}
        </div>
      </div>
    </header>
  );
}
