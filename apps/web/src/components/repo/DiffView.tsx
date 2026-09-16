import { useTranslation } from 'react-i18next';
import type { FileDiff } from '../../types';
import { Badge } from '../ui/Badge';
import { Card, CardHeader, CardTitle } from '../ui/Card';

function lineClass(kind: string): string {
  if (kind === 'add') return 'bg-[var(--color-success-bg)] text-[var(--color-text-primary)]';
  if (kind === 'remove') return 'bg-[var(--color-error-bg)] text-[var(--color-text-primary)]';
  return 'text-[var(--color-text-secondary)]';
}

function typeVariant(type: string): 'success' | 'error' | 'info' {
  if (type === 'add') return 'success';
  if (type === 'remove') return 'error';
  return 'info';
}

export function DiffView({ files, truncated }: { files: FileDiff[]; truncated: boolean }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('commits.diff', 'Diff')}</CardTitle>
        {truncated && <Badge variant="warning">{t('pulls.truncated', 'Truncated')}</Badge>}
      </CardHeader>
      {files.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t('pulls.noChanges', 'No Changes.')}</p>
      ) : (
        <ul className="space-y-5">
          {files.map((f) => (
            <li key={f.path} className="min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <Badge variant={typeVariant(f.type)}>{f.type}</Badge>
                <span className="font-mono text-sm text-[var(--color-text-primary)] truncate">{f.path}</span>
              </div>
              {f.binary ? (
                <p className="text-sm text-[var(--color-text-muted)]">{t('repos.binaryFile', 'Binary File — Not Previewed.')}</p>
              ) : f.tooLarge ? (
                <p className="text-sm text-[var(--color-text-muted)]">{t('commits.diffTooLarge', 'Diff Too Large To Display.')}</p>
              ) : (
                <div className="space-y-3">
                  {f.hunks.map((h, hi) => (
                    <div key={hi} className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
                      <p className="px-3 py-1 text-xs font-mono text-[var(--color-text-muted)] bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
                        @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                      </p>
                      <pre className="font-mono text-xs leading-relaxed">
                        {h.lines.map((l, li) => (
                          <div key={li} className={`flex px-3 whitespace-pre-wrap break-words ${lineClass(l.kind)}`}>
                            <span className="w-10 shrink-0 select-none text-right mr-3 opacity-60">{l.oldNo ?? ''}</span>
                            <span className="w-10 shrink-0 select-none text-right mr-3 opacity-60">{l.newNo ?? ''}</span>
                            <span className="w-4 shrink-0 select-none opacity-60">
                              {l.kind === 'add' ? '+' : l.kind === 'remove' ? '−' : ' '}
                            </span>
                            <span className="min-w-0">{l.text === '' ? ' ' : l.text}</span>
                          </div>
                        ))}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
