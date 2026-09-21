import { describe, expect, it } from 'vitest';
import { headLabel, mergeHeadRepoOptions, sameRepoName } from '../apps/web/src/components/repo/pullHeadOptions';
import { splitRepo } from '../apps/web/src/components/org/teamRepoInput';
import { MAX_EDIT_CHARS, findReadmeEntry, isEditableSize, isReadmePath } from '../apps/web/src/components/repo/codeTabUtils';
import type { PullRequest, Repo, TreeEntry } from '../apps/web/src/types';

function pull(overrides: Partial<PullRequest> = {}): PullRequest {
  return { full_name: 'alice/demo', head_full_name: 'alice/demo', head_branch: 'feat', ...overrides } as PullRequest;
}

function repo(fullName: string): Repo {
  return { fullName } as Repo;
}

function entry(path: string, type = 'blob'): TreeEntry {
  return { path, type } as TreeEntry;
}

describe('slice4: pullHeadOptions', () => {
  it('labels same-repo heads by branch, forks by full name', () => {
    expect(headLabel(pull())).toBe('feat');
    expect(headLabel(pull({ head_full_name: 'ALICE/demo' }))).toBe('feat');
    expect(headLabel(pull({ head_full_name: 'bob/demo' }))).toBe('bob/demo:feat');
  });

  it('compares repo names case-insensitively', () => {
    expect(sameRepoName('Alice/Demo', 'alice/demo')).toBe(true);
    expect(sameRepoName('alice/demo', 'bob/demo')).toBe(false);
  });

  it('merges current, parent, and forks without duplicates', () => {
    const out = mergeHeadRepoOptions('alice/demo', 'upstream/root', [repo('bob/demo'), repo('ALICE/demo')], 'bob/demo');
    expect(out.options).toEqual(['alice/demo', 'upstream/root', 'bob/demo']);
    expect(out.selected).toBe('bob/demo');
  });

  it('falls back to current when the previous selection vanished', () => {
    const out = mergeHeadRepoOptions('alice/demo', null, [], 'gone/demo');
    expect(out).toEqual({ options: ['alice/demo'], selected: 'alice/demo' });
  });

  it('skips blank parents and dedupes case-insensitively', () => {
    const out = mergeHeadRepoOptions('alice/demo', 'ALICE/DEMO', [repo('alice/demo')], 'alice/demo');
    expect(out.options).toEqual(['alice/demo']);
  });
});

describe('slice4: teamRepoInput', () => {
  it('parses owner/repo and strips .git', () => {
    expect(splitRepo('acme/demo')).toEqual({ owner: 'acme', repo: 'demo' });
    expect(splitRepo('  acme/demo.git  ')).toEqual({ owner: 'acme', repo: 'demo' });
  });

  it('rejects malformed input', () => {
    expect(splitRepo('noslash')).toBe(null);
    expect(splitRepo('a/b/c')).toBe(null);
    expect(splitRepo('/demo')).toBe(null);
    expect(splitRepo('acme/')).toBe(null);
    expect(splitRepo('')).toBe(null);
  });
});

describe('slice4: codeTabUtils', () => {
  it('recognizes readme names', () => {
    expect(isReadmePath('README.md')).toBe(true);
    expect(isReadmePath('README')).toBe(true);
    expect(isReadmePath('readme.md')).toBe(false);
    expect(isReadmePath('CHANGELOG.md')).toBe(false);
  });

  it('finds the readme only at the repo root', () => {
    const entries = [entry('src'), entry('README.md'), entry('docs/README.md')];
    expect(findReadmeEntry(entries, '')?.path).toBe('README.md');
    expect(findReadmeEntry(entries, 'src')).toBe(undefined);
    expect(findReadmeEntry([entry('main.ts')], '')).toBe(undefined);
  });

  it('gates in-browser editing on size', () => {
    expect(isEditableSize(0)).toBe(true);
    expect(isEditableSize(MAX_EDIT_CHARS)).toBe(true);
    expect(isEditableSize(MAX_EDIT_CHARS + 1)).toBe(false);
    expect(isEditableSize(10, 9)).toBe(false);
  });
});
