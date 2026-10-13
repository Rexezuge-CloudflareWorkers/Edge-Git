import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCopyToClipboard } from '@rexezuge/web';
import { Label } from '../ui/Input';
import { cn } from '../../lib/utils';

export function ReadOnlyField({ label, value, showCopy = false }: { label: string; value: string; showCopy?: boolean }) {
  const { t } = useTranslation();
  // The checkmark tracks a write that actually resolved. This field carries
  // copy-once secrets and destructive-action names, so a false success sends
  // the operator away believing they have something they do not.
  const { copied, copy } = useCopyToClipboard();

  return (
    <div>
      <Label className="mb-1.5">{label}</Label>
      <div className="flex">
        <input
          readOnly
          value={value}
          className={cn(
            'min-w-0 px-3 py-2 bg-[var(--color-surface-base)] border border-[var(--color-border)] text-[var(--color-text-secondary)] text-sm flex-1',
            showCopy ? 'rounded-l-lg border-r-0' : 'rounded-lg',
          )}
        />
        {showCopy && (
          <button
            type="button"
            onClick={() => copy(value)}
            className="px-3 py-2 rounded-r-lg bg-[var(--color-surface-3)] hover:bg-[var(--color-surface-4)] border border-[var(--color-border)] text-[var(--color-text-secondary)] transition-colors duration-150"
            title={t('common.copyToClipboard', 'Copy To Clipboard')}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-success-text)]" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}
