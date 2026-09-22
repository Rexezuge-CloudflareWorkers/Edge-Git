import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Package } from 'lucide-react';
import { createRelease } from '../../services/releaseService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Textarea } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { ReleaseRow } from './ReleaseRow';
import { useReleases } from './useReleases';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

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
  const { releases, untagged, loading, refresh } = useReleases({ owner, repo, authorized, showNotice, onCountChange });
  const [tagName, setTagName] = useState('');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [isPrerelease, setIsPrerelease] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tagName.trim()) return;
    setSaving(true);
    try {
      await createRelease(owner, repo, {
        tagName: tagName.trim(),
        name: name.trim() || undefined,
        body: body.trim() || undefined,
        isDraft: true,
        isPrerelease,
      });
      setTagName('');
      setName('');
      setBody('');
      setIsPrerelease(false);
      showNotice('success', t('releases.created', 'Release Created.'));
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'releases.failedToCreate', 'Failed To Create Release.'));
    } finally {
      setSaving(false);
    }
  };

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
              <ReleaseRow
                key={r.id}
                owner={owner}
                repo={repo}
                release={r}
                canWrite={canWrite}
                authorized={authorized}
                showNotice={showNotice}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
