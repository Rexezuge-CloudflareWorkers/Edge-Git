import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CheckRun } from '../../types';
import { listChecks } from '../../services/checkService';
import type { CheckCombinedState } from '../../services/checkService';
import { checksChannel } from '../../realtime/protocol';
import { useRealtimeSubscription } from '../../realtime/useRealtime';
import { Badge } from '../ui/Badge';
import { RefreshButton } from '../shared/RefreshButton';

function variantFor(run: CheckRun): 'success' | 'error' | 'warning' | 'neutral' | 'info' {
  if (run.status !== 'completed' || !run.conclusion) return run.status === 'in_progress' ? 'info' : 'neutral';
  if (['success', 'neutral', 'skipped'].includes(run.conclusion)) return 'success';
  if (['failure', 'timed_out'].includes(run.conclusion)) return 'error';
  return 'warning';
}

function labelFor(run: CheckRun): string {
  if (run.status !== 'completed') return run.status === 'in_progress' ? 'Running' : 'Queued';
  return run.conclusion ?? run.status;
}

export function PullChecks({ owner, repo, headOid, authorized }: { owner: string; repo: string; headOid: string | null; authorized?: boolean | null }) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<CheckRun[]>([]);
  const [state, setState] = useState<CheckCombinedState>('pending');
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!headOid) return;
    let cancelled = false;
    listChecks(owner, repo, headOid)
      .then((res) => {
        if (cancelled) return;
        setRuns(res.checks);
        setState(res.state);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [owner, repo, headOid, reloadKey]);

  // Live check updates: any `check_run` event on this SHA refetches the list,
  // so the badge flips without a manual refresh. Signed-in viewers only
  // (ticket issuance requires auth); everyone else keeps the button.
  const channel = headOid ? checksChannel(headOid) : null;
  useRealtimeSubscription({
    enabled: channel !== null && authorized === true,
    ticket: { kind: 'repo', owner, repo, channels: channel ? [channel] : [] },
    onEvent: (event) => {
      if (event.type !== 'check_run.updated' && event.type !== 'check_run.queued') return;
      setLoading(true);
      setReloadKey((k) => k + 1);
    },
  });

  if (!headOid) return null;

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('checks.title', 'Status Checks')}</h3>
        <Badge variant={state === 'success' ? 'success' : state === 'failure' ? 'error' : 'neutral'}>
          {state === 'success'
            ? t('checks.success', 'Passing')
            : state === 'failure'
              ? t('checks.failure', 'Failing')
              : t('checks.pending', 'Pending')}
        </Badge>
        <RefreshButton onRefresh={refresh} loading={loading} />
      </div>
      {runs.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">{t('checks.noChecks', 'No Checks Reported For This Commit Yet.')}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {runs.map((run) => (
            <li key={run.id} className="flex items-center gap-2 text-sm flex-wrap">
              <Badge variant={variantFor(run)}>{labelFor(run)}</Badge>
              <span className="font-mono text-[var(--color-text-primary)]">{run.context}</span>
              {run.outputTitle && <span className="text-xs text-[var(--color-text-muted)]">{run.outputTitle}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
