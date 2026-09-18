import { useTranslation } from 'react-i18next';
import { File, Folder } from 'lucide-react';
import type { GitCommit, TreeEntry } from '../../types';
import { firstLine, formatCommitDate, formatTimestamp } from '../../lib/format';
import { Card } from '../ui/Card';
import { NewFileForm } from './FileEditor';

export function FileBrowser({
  owner,
  repo,
  branch,
  directory,
  entries,
  latestCommit,
  loading,
  showNewFile,
  showEmptyCreate,
  emptyCreateBranch,
  branchTip,
  showNotice,
  onSaved,
  onOpenBlob,
  onNavigate,
}: {
  owner: string;
  repo: string;
  branch: string;
  directory: string;
  entries: TreeEntry[];
  latestCommit: GitCommit | undefined;
  loading: boolean;
  showNewFile: boolean;
  showEmptyCreate: boolean;
  emptyCreateBranch: string;
  branchTip?: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onSaved: () => void;
  onOpenBlob: (entryPath: string) => void | Promise<void>;
  onNavigate: (dir: string) => void;
}) {
  const { t } = useTranslation();
  const crumbs = directory ? directory.split('/') : [];
  return (
    <>
      {showNewFile && (
        <Card>
          <h2 className="text-base font-semibold text-[var(--color-text-primary)] mb-3">{t('files.newFile', 'New File')}</h2>
          <NewFileForm
            owner={owner}
            repo={repo}
            branch={branch}
            directory={directory}
            expectedOid={branchTip}
            showNotice={showNotice}
            onSaved={onSaved}
          />
        </Card>
      )}
      <Card className="p-0 overflow-hidden">
        {latestCommit && (
          <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] text-sm min-w-0">
            <span className="h-6 w-6 rounded-full bg-[var(--color-surface-4)] text-[var(--color-text-secondary)] inline-flex items-center justify-center text-xs font-medium shrink-0">
              {latestCommit.commit.author.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="text-[var(--color-text-primary)] truncate flex-1">{firstLine(latestCommit.commit.message)}</span>
            <code className="font-mono text-xs text-[var(--color-text-muted)] shrink-0 hidden sm:inline">
              {latestCommit.oid.slice(0, 7)}
            </code>
            <span className="text-xs text-[var(--color-text-muted)] shrink-0 hidden md:inline">
              {formatCommitDate(latestCommit.commit.author.timestamp, latestCommit.commit.author.timezoneOffset)}
            </span>
          </div>
        )}
        {!loading && entries.length === 0 ? (
          showEmptyCreate ? (
            <div className="p-5 space-y-3">
              <p className="text-sm text-[var(--color-text-muted)]">
                {t('files.createFirstFile', 'Create The First File To Start This Repository.')}
              </p>
              <NewFileForm
                owner={owner}
                repo={repo}
                branch={emptyCreateBranch}
                directory=""
                expectedOid={undefined}
                showNotice={showNotice}
                onSaved={onSaved}
              />
            </div>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)] p-5">
              {t('repos.emptyRepository', 'Empty Repository — Push A Branch To Get Started.')}
            </p>
          )
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {directory && (
              <li>
                <button
                  type="button"
                  className="w-full text-left px-5 py-2.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
                  onClick={() => onNavigate(crumbs.slice(0, -1).join('/'))}
                >
                  ..
                </button>
              </li>
            )}
            {entries.map((e) => (
              <li key={e.oid + e.path}>
                <button
                  type="button"
                  className="w-full flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-[var(--color-surface-2)] text-left"
                  onClick={() => {
                    if (e.type === 'tree') {
                      onNavigate(directory ? `${directory}/${e.path}` : e.path);
                    } else {
                      void onOpenBlob(e.path);
                    }
                  }}
                >
                  {e.type === 'tree' ? (
                    <Folder className="h-4 w-4 text-[var(--color-info-text)] shrink-0" />
                  ) : (
                    <File className="h-4 w-4 text-[var(--color-text-muted)] shrink-0" />
                  )}
                  <span className="text-[var(--color-text-primary)] truncate flex-1">{e.path}</span>
                  <span className="text-xs text-[var(--color-text-muted)] truncate max-w-64 hidden md:inline">
                    {e.lastCommit ? firstLine(e.lastCommit.commit.message) : ''}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)] shrink-0">
                    {e.lastCommit ? formatTimestamp(e.lastCommit.commit.author.timestamp) : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
