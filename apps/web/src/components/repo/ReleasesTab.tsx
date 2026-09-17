import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Package } from 'lucide-react';
import type { TagInfo } from '../../types';
import type { Release, ReleaseAsset } from '../../services/releaseService';
import {
  createRelease,
  deleteRelease,
  deleteReleaseAsset,
  listReleaseAssets,
  listReleases,
  releaseAssetDownloadUrl,
  updateRelease,
  uploadReleaseAsset,
} from '../../services/releaseService';
import { loadTags } from '../../services/repoService';
import { formatTimestamp } from '../../lib/format';
import { formatBytes } from '../../lib/format';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Textarea } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { Markdown } from '../shared/Markdown';

function ReleaseRow({
  owner,
  repo,
  release,
  canWrite,
  authorized,
  showNotice,
  onChanged,
}: {
  owner: string;
  repo: string;
  release: Release;
  canWrite: boolean;
  authorized?: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onChanged: () => void;
}) {
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
      showNotice('error', error instanceof Error ? error.message : t('releases.actionFailed', 'Release Action Failed.'));
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
      showNotice('error', error instanceof Error ? error.message : t('releases.actionFailed', 'Release Action Failed.'));
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
      showNotice('error', error instanceof Error ? error.message : t('releases.actionFailed', 'Release Action Failed.'));
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
      showNotice('error', error instanceof Error ? error.message : t('releases.actionFailed', 'Release Action Failed.'));
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
        {t('releases.publishedBy', 'By {{email}} · {{date}}', { email: release.createdBy, date: formatTimestamp(release.createdAt) })}
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

export function ReleasesTab({
  owner,
  repo,
  canWrite,
  showNotice,
  onCountChange,
  authorized,
}: {
  owner: string;
  repo: string;
  canWrite: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onCountChange?: (count: number) => void;
  authorized?: boolean | null;
}) {
  const { t } = useTranslation();
  const [releases, setReleases] = useState<Release[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [tagName, setTagName] = useState('');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [isPrerelease, setIsPrerelease] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        const list = await listReleases(owner, repo, authOpt);
        setReleases(list);
        onCountChange?.(list.length);
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadReleases', 'Failed To Load Releases.'));
      } finally {
        setLoading(false);
      }
      try {
        setTags(await loadTags(owner, repo, authOpt));
      } catch {
        setTags([]);
      }
    };
    void run();
  }, [owner, repo, showNotice, onCountChange, reloadKey, t, authorized]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tagName.trim()) return;
    setSaving(true);
    try {
      await createRelease(owner, repo, { tagName: tagName.trim(), name: name.trim() || undefined, body: body.trim() || undefined, isDraft: true, isPrerelease });
      setTagName('');
      setName('');
      setBody('');
      setIsPrerelease(false);
      showNotice('success', t('releases.created', 'Release Created.'));
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('releases.failedToCreate', 'Failed To Create Release.'));
    } finally {
      setSaving(false);
    }
  };

  const untagged = tags.filter((tag) => releases.every((r) => r.tagName !== tag.name));

  return (
    <div className="space-y-4">
      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>{t('releases.newRelease', 'New Release')}</CardTitle>
          </CardHeader>
          <form onSubmit={submit} className="space-y-3">
            <div className="flex gap-2 flex-wrap">
              <Input
                placeholder={t('releases.tagPlaceholder', 'Tag (e.g. v1.0.0)')}
                value={tagName}
                onChange={(e) => setTagName(e.target.value)}
                required
              />
              {untagged.length > 0 && (
                <select
                  aria-label={t('releases.pickTag', 'Pick An Existing Tag')}
                  className="text-sm border border-[var(--color-border)] rounded px-2 py-1.5 bg-[var(--color-surface-1)]"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) setTagName(e.target.value);
                  }}
                >
                  <option value="">{t('releases.pickTag', 'Pick An Existing Tag')}</option>
                  {untagged.slice(0, 50).map((tag) => (
                    <option key={tag.ref} value={tag.name}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <Input placeholder={t('releases.namePlaceholder', 'Title (Optional)')} value={name} onChange={(e) => setName(e.target.value)} />
            <Textarea
              placeholder={t('releases.bodyPlaceholder', 'Release Notes (Optional)')}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
            />
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <input type="checkbox" checked={isPrerelease} onChange={(e) => setIsPrerelease(e.target.checked)} />
              {t('releases.prerelease', 'Prerelease')}
            </label>
            <Button type="submit" variant="primary" size="sm" loading={saving}>
              {t('releases.createRelease', 'Create Draft Release')}
            </Button>
          </form>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('releases.releases', 'Releases')}</CardTitle>
          <RefreshButton onRefresh={refresh} loading={loading} />
        </CardHeader>
        {!loading && releases.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">
            <Package className="h-6 w-6 mx-auto mb-3" />
            {t('releases.noReleases', 'No Releases Yet.')}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {releases.map((r) => (
              <ReleaseRow key={r.id} owner={owner} repo={repo} release={r} canWrite={canWrite} authorized={authorized} showNotice={showNotice} onChanged={refresh} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
