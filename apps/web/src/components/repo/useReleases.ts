import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TagInfo } from '../../types';
import type { Release } from '../../services/releaseService';
import { listReleases } from '../../services/releaseService';
import { loadTags } from '../../services/repoService';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export interface UseReleasesOptions {
  owner: string;
  repo: string;
  authorized?: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onCountChange?: (count: number) => void;
}

/**
 * Pure untagged-tag selector: tags with no matching release. Extracted so
 * the release create form stays presentational and the rule is unit-tested
 * (`test/web-pass4.test.ts`) without React.
 */
export function selectUntaggedTags(tags: TagInfo[], releases: Release[]): TagInfo[] {
  return tags.filter((tag) => releases.every((r) => r.tagName !== tag.name));
}

/**
 * Releases data slice (Container/Presenter split): aggregate releases +
 * tags loading with a `reloadKey` refresh, mirroring `useCodeTabOverview`.
 * The create form and row rendering stay in `ReleasesTab` / `ReleaseRow`.
 */
export function useReleases({ owner, repo, authorized, showNotice, onCountChange }: UseReleasesOptions) {
  const { t } = useTranslation();
  const [releases, setReleases] = useState<Release[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        const list = await listReleases(owner, repo, authOpt);
        setReleases(list);
        onCountChange?.(list.length);
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadReleases', 'Failed To Load Releases.'));
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

  return { releases, tags, untagged: selectUntaggedTags(tags, releases), loading, refresh };
}
