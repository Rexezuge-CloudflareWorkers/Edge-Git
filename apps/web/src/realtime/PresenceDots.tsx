import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';
import type { RealtimeStatus } from './useRealtime';

// Live presence badge for issue/PR views. Renders nothing until the socket is
// live; shows a plain Live marker for solo viewers and the viewer count once
// collaborators join. The roster includes the current viewer.
export function PresenceDots({ status, viewers }: { status: RealtimeStatus; viewers: string[] }) {
  const { t } = useTranslation();
  if (status !== 'live') return null;
  const others = viewers.length <= 1 ? 0 : viewers.length - 1;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
      title={viewers.join(', ')}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', others > 0 ? 'bg-green-500' : 'bg-[var(--color-accent)]')} />
      {others > 0
        ? t('realtime.viewingCount', '{{count}} Viewing', { count: viewers.length })
        : t('realtime.live', 'Live')}
    </span>
  );
}
