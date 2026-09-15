import { describe, expect, it } from 'vitest';
import { RepoService } from '@edge-git/backend-services/repo';

describe('RepoService naming', () => {
  it('strips .git suffix', () => {
    expect(RepoService.normalizeRepo('myrepo.git')).toBe('myrepo');
    expect(RepoService.normalizeRepo('myrepo')).toBe('myrepo');
  });

  it('validates owner/repo names', () => {
    expect(() => RepoService.validateNames('alice', 'my-repo_1')).not.toThrow();
    expect(() => RepoService.validateNames('alice!', 'repo')).toThrow();
    expect(() => RepoService.validateNames('alice', '')).toThrow();
  });
});
