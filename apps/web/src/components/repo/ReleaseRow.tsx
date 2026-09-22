import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Release, ReleaseAsset } from '../../services/releaseService';
import {
  deleteRelease,
  deleteReleaseAsset,
  listReleaseAssets,
  releaseAssetDownloadUrl,
  updateRelease,
  uploadReleaseAsset,
} from '../../services/releaseService';
import { formatBytes, formatTimestamp } from '../../lib/format';
import { Button } from '../ui/Button';
import { Markdown } from '../shared/Markdown';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export interface ReleaseRowProps {
  owner: string;
  repo: string;
  release: Release;
  canWrite: boolean;
  authorized?: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onChanged: () => void;
}

/**
 * Single release row (presentational + row-scoped asset fetching),
 * extracted from `ReleasesTab` (Container/Presenter split). Owns only its
 * own assets/upload state; list-level loading lives in `useReleases`.
 */
export function ReleaseRow({ owner, repo, release, canWrite, authorized, showNotice, onChanged }: ReleaseRowProps) {
  const { t } = useTranslation();
  const [assets, setAssets] = useState<ReleaseAsset[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        setAssets(await listReleaseAssets(owner, repo, release.tagName));
      } catch {
        if (!cancelled) setAssets([]);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, release.tagName]);

  const publish = async () => {
    setBusy(true);
    try {
      await updateRelease(owner, repo, release.tagName, { isDraft: false });
      showNotice('success', t('releases.published', 'Release Published.'));
      onChanged();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'releases.actionFailed', 'Release Action Failed.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!globalThis.confirm(t('releases.deleteConfirm', 'Delete This Release? Assets Are Removed Too.'))) return;
    setBusy(true);
    try {
      await deleteRelease(owner, repo, release.tagName);
      showNotice('success', t('releases.deleted', 'Release Deleted.'));
      onChanged();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'releases.actionFailed', 'Release Action Failed.'));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      await uploadReleaseAsset(owner, repo, release.tagName, file);
      setAssets(await listReleaseAssets(owner, repo, release.tagName));
      showNotice('success', t('releases.assetUploaded', 'Asset Uploaded.'));
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'releases.actionFailed', 'Release Action Failed.'));
    } finally {
      setUploading(false);
    }
  };

  const removeAsset = async (asset: ReleaseAsset) => {
    try {
      await deleteReleaseAsset(owner, repo, release.tagName, asset.id);
      setAssets((prev) => prev.filter((a) => a.id !== asset.id));
      showNotice('success', t('releases.assetDeleted', 'Asset Deleted.'));
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'releases.actionFailed', 'Release Action Failed.'));
    }
  };

  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-[var(--color-text-primary)]">{release.name || release.tagName}</span>
        <span className="text-xs text-[var(--color-text-muted)]">{release.tagName}</span>
        {release.isDraft && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
            {t('releases.draft', 'Draft')}
          </span>
        )}
        {release.isPrerelease && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
            {t('releases.prerelease', 'Prerelease')}
          </span>
        )}
      </div>
      {release.body && (
        <div className="mt-1 text-sm text-[var(--color-text-secondary)]">
          <Markdown content={release.body.slice(0, 2000)} />
        </div>
      )}
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        {t('releases.publishedBy', 'By {{username}} · {{date}}', { username: release.createdBy, date: formatTimestamp(release.createdAt) })}
      </p>
      {assets.length > 0 && (
        <ul className="mt-2 space-y-1">
          {assets.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-sm flex-wrap">
              <a
                className="text-[var(--color-accent)] hover:underline"
                href={releaseAssetDownloadUrl(owner, repo, release.tagName, a.id, authorized === true)}
              >
                {a.name}
              </a>
              <span className="text-xs text-[var(--color-text-muted)]">{formatBytes(a.size)}</span>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => void removeAsset(a)}
                  className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                >
                  {t('common.delete', 'Delete')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {release.isDraft && (
            <Button type="button" variant="primary" size="sm" loading={busy} onClick={() => void publish()}>
              {t('releases.publish', 'Publish')}
            </Button>
          )}
          <label className="text-sm text-[var(--color-accent)] cursor-pointer hover:underline">
            {uploading ? t('common.loading', 'Loading…') : t('releases.uploadAsset', 'Upload Asset')}
            <input
              type="file"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
          >
            {t('common.delete', 'Delete')}
          </button>
        </div>
      )}
    </li>
  );
}
