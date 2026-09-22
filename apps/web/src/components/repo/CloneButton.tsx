import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Code, Copy, Lock, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { Label } from '../ui/Input';
import { cn } from '../../lib/utils';
import { COPY_FEEDBACK_TIMEOUT_MS } from '../../lib/constants';

export function buildHttpsCloneUrl(origin: string, owner: string, repo: string): string {
  return `${origin}/${owner}/${repo}.git`;
}

export function buildSshCloneUrl(host: string, owner: string, repo: string): string {
  return `git@${host}:${owner}/${repo}.git`;
}

type CloneMethod = 'https' | 'ssh';

export function CloneButton({ owner, repo }: { owner: string; repo: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<CloneMethod>('https');
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const origin = globalThis.location?.origin ?? '';
  const host = globalThis.location?.host ?? '';
  const httpsUrl = buildHttpsCloneUrl(origin, owner, repo);
  const sshUrl = buildSshCloneUrl(host, owner, repo);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current || rootRef.current.contains(e.target as Node)) {
        return;
      }

      setOpen(false);
      setCopied(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        return;
      }

      setOpen(false);
      setCopied(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleCopy = (value: string) => {
    void navigator.clipboard.writeText(value).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_TIMEOUT_MS);
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <Button
        variant="primary"
        size="sm"
        onClick={() => {
          setOpen((o) => !o);
          setCopied(false);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Code className="h-3.5 w-3.5" />
        {t('repos.code', 'Code')}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-150', open && 'rotate-180')} />
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label={t('repos.cloneRepository', 'Clone Repository')}
          className="absolute right-0 mt-2 w-80 z-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-2xl animate-slide-down overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
            <span className="text-sm font-semibold text-[var(--color-text-primary)]">{t('repos.clone', 'Clone')}</span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setCopied(false);
              }}
              aria-label={t('repos.closeCloneMenu', 'Close Clone Menu')}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors p-1 rounded-lg hover:bg-[var(--color-surface-3)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="p-4 space-y-3">
            <div
              role="tablist"
              aria-label={t('repos.cloneMethod', 'Clone Method')}
              className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--color-surface-base)] border border-[var(--color-border)] p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={method === 'https'}
                onClick={() => setMethod('https')}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-medium transition-colors duration-150',
                  method === 'https'
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                )}
              >
                HTTPS
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={method === 'ssh'}
                onClick={() => setMethod('ssh')}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-medium transition-colors duration-150 inline-flex items-center justify-center gap-1.5',
                  method === 'ssh'
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
                )}
              >
                SSH
                <Lock className="h-3 w-3" />
              </button>
            </div>

            {method === 'https' ? (
              <div className="space-y-3">
                <div>
                  <Label className="mb-1.5">{t('repos.cloneWithHttps', 'Clone Using HTTPS')}</Label>
                  <div className="flex">
                    <input
                      readOnly
                      value={httpsUrl}
                      aria-label={t('repos.httpsCloneUrl', 'HTTPS Clone URL')}
                      className="min-w-0 px-3 py-2 bg-[var(--color-surface-base)] border border-[var(--color-border)] border-r-0 rounded-l-lg text-[var(--color-text-secondary)] text-xs font-mono flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => handleCopy(httpsUrl)}
                      title={t('common.copyToClipboard', 'Copy To Clipboard')}
                      className="px-3 py-2 rounded-r-lg bg-[var(--color-surface-3)] hover:bg-[var(--color-surface-4)] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors duration-150"
                    >
                      {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-success-text)]" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
                <p className="text-xs text-[var(--color-text-secondary)]">{t('repos.httpsHint', 'Use A Personal Access Token As The Password For Private Fetch And Push.')}</p>
                <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-base)] px-3 py-2 font-mono text-xs text-[var(--color-text-secondary)] break-all">
                  git clone {httpsUrl}
                </p>
              </div>
            ) : (
              <div className="space-y-3" aria-disabled="true">
                <div className="opacity-60">
                  <Label className="mb-1.5">{t('repos.cloneWithSsh', 'Clone Using SSH')}</Label>
                  <div className="flex">
                    <input
                      readOnly
                      disabled
                      value={sshUrl}
                      aria-label={t('repos.sshCloneUrlDisabled', 'SSH Clone URL (disabled)')}
                      className="min-w-0 px-3 py-2 bg-[var(--color-surface-base)] border border-[var(--color-border)] border-r-0 rounded-l-lg text-[var(--color-text-muted)] text-xs font-mono flex-1 cursor-not-allowed"
                    />
                    <span className="px-3 py-2 rounded-r-lg bg-[var(--color-surface-3)] border border-[var(--color-border)] text-[var(--color-text-muted)] inline-flex items-center">
                      <Lock className="h-3.5 w-3.5" />
                    </span>
                  </div>
                </div>
                <p className="text-xs text-[var(--color-text-muted)] inline-flex items-start gap-1.5">
                  <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  {t('repos.sshUnsupported', 'SSH Keys Are Not Supported Yet. Use HTTPS With A Personal Access Token.')}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
