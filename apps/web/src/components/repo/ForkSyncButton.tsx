import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { previewSync, syncFork } from '../../services/collabService';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export function ForkSyncButton({
  owner,
  repo,
  upstreamFull,
  branch,
  showNotice,
  onSynced,
}: {
  owner: string;
  repo: string;
  upstreamFull: string;
  branch: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onSynced?: () => void;
}) {
  const { t } = useTranslation();
  const [syncing, setSyncing] = useState(false);
  const [preview, setPreview] = useState<{ alreadyMerged: boolean; canFastForward: boolean } | null>(null);

  const check = async () => {
    const slash = upstreamFull.indexOf('/');
    if (slash <= 0) return;
    try {
      const res = await previewSync(owner, repo, {
        upstreamOwner: upstreamFull.slice(0, slash),
        upstreamRepo: upstreamFull.slice(slash + 1),
        upstreamBranch: 'main',
        branch,
      });
      setPreview(res.preview);
      if (res.preview?.alreadyMerged) showNotice('success', t('forks.upToDate', 'Fork Is Already Up To Date.'));
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToPreviewSync', 'Failed To Preview Sync.'));
    }
  };

  const run = async () => {
    const slash = upstreamFull.indexOf('/');
    if (slash <= 0) return;
    setSyncing(true);
    try {
      await syncFork(owner, repo, {
        upstreamOwner: upstreamFull.slice(0, slash),
        upstreamRepo: upstreamFull.slice(slash + 1),
        upstreamBranch: 'main',
        branch,
      });
      showNotice('success', t('forks.synced', 'Fork Synced With Upstream.'));
      onSynced?.();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToSync', 'Failed To Sync Fork.'));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Button size="sm" variant="secondary" onClick={() => void check()}>
        {t('forks.checkSync', 'Check Upstream')}
      </Button>
      {preview && !preview.alreadyMerged && (
        <Button size="sm" variant="primary" loading={syncing} onClick={() => void run()}>
          {preview.canFastForward ? t('forks.syncFastForward', 'Sync (Fast-Forward)') : t('forks.syncMerge', 'Sync (Merge)')}
        </Button>
      )}
    </div>
  );
}
