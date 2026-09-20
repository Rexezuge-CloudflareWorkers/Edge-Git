import type { TagInfo } from '../../types';
import { Select } from '../ui/Input';
import { Button } from '../ui/Button';
import { RefreshButton } from '../shared/RefreshButton';
import { CloneButton } from './CloneButton';
import { ForkButton } from './ForkButton';
import { StarButton, WatchButton } from './SocialButtons';
import type { useSocialState } from './SocialButtons';
import { BranchActions } from './BranchActions';
import { TagPicker } from './TagsCard';

interface CodeTabToolbarProps {
  owner: string;
  repo: string;
  branches: string[];
  defaultBranch: string | null;
  selectedRef: string;
  placeholderLabel: string;
  refParam: string;
  path: string;
  crumbs: string[];
  tags: TagInfo[];
  loading: boolean;
  editable: boolean;
  canWrite: boolean;
  canFork: boolean;
  forkOwner: string;
  social: ReturnType<typeof useSocialState>;
  showNotice: (type: 'success' | 'error', text: string) => void;
  navigateBrowser: (patch: { ref?: string; path?: string; blob?: string | null }) => void;
  setLoading: (v: boolean) => void;
  setBlobText: (v: string | null) => void;
  setBlobBinary: (v: boolean) => void;
  setReadme: (v: { path: string; text: string } | null) => void;
  setReloadKey: (fn: (k: number) => number) => void;
  setCreateDir: (fn: (d: string | null) => string | null) => void;
  onRefresh: () => void;
}

// Toolbar facade (Otter pattern): branch/tag pickers + branch actions +
// breadcrumbs + social/clone/refresh buttons. Extracted from CodeTab so the
// tab stays a thin composition root under the god-file guard.
export function CodeTabToolbar(props: CodeTabToolbarProps) {
  const {
    owner,
    repo,
    branches,
    defaultBranch,
    selectedRef,
    placeholderLabel,
    refParam,
    path,
    crumbs,
    tags,
    loading,
    editable,
    canWrite,
    canFork,
    forkOwner,
    social,
    showNotice,
    navigateBrowser,
    setLoading,
    setBlobText,
    setBlobBinary,
    setReadme,
    setReloadKey,
    setCreateDir,
    onRefresh,
  } = props;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select
        value={selectedRef}
        onChange={(e) => {
          setLoading(true);
          navigateBrowser({ ref: e.target.value, blob: null });
          setBlobText(null);
          setBlobBinary(false);
          setReadme(null);
        }}
        aria-label="Branch"
        disabled={branches.length === 0}
      >
        {!branches.includes(selectedRef) && <option value="">{placeholderLabel}</option>}
        {branches.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </Select>
      <TagPicker
        tags={tags}
        value={refParam.startsWith('refs/tags/') ? refParam : ''}
        onChange={(tagRef) => {
          setLoading(true);
          navigateBrowser({ ref: tagRef, path: '', blob: null });
          setBlobText(null);
          setBlobBinary(false);
          setReadme(null);
        }}
      />
      {canWrite && (
        <BranchActions
          owner={owner}
          repo={repo}
          branches={branches}
          defaultBranch={defaultBranch}
          selectedRef={selectedRef}
          showNotice={showNotice}
          onChanged={(nextRef) => {
            setLoading(true);
            navigateBrowser({ ref: nextRef, path: '', blob: null });
            setBlobText(null);
            setBlobBinary(false);
            setReadme(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
      {editable && (
        <Button
          size="sm"
          onClick={() => {
            setCreateDir((d) => (d === path ? null : path));
            navigateBrowser({ blob: null });
            setBlobText(null);
            setBlobBinary(false);
          }}
        >
          New File
        </Button>
      )}
      {path && (
        <nav className="text-sm text-[var(--color-text-secondary)]">
          <button type="button" className="text-[var(--color-accent)] hover:underline" onClick={() => navigateBrowser({ path: '' })}>
            {repo}
          </button>
          {crumbs.map((c, i) => (
            <span key={i}>
              {' / '}
              <button
                type="button"
                className="text-[var(--color-accent)] hover:underline"
                onClick={() => navigateBrowser({ path: crumbs.slice(0, i + 1).join('/') })}
              >
                {c}
              </button>
            </span>
          ))}
        </nav>
      )}
      <div className="ml-auto flex items-center gap-2">
        <RefreshButton onRefresh={onRefresh} loading={loading} />
        <WatchButton
          watching={social.watching}
          watchersCount={social.watchersCount}
          disabled={social.busy !== null}
          onToggle={() => void social.toggleWatch()}
        />
        {canFork && <ForkButton owner={owner} repo={repo} defaultOwner={forkOwner} showNotice={showNotice} />}
        <StarButton
          starred={social.starred}
          starsCount={social.starsCount}
          disabled={social.busy !== null}
          onToggle={() => void social.toggleStar()}
        />
        <CloneButton owner={owner} repo={repo} />
      </div>
    </div>
  );
}
