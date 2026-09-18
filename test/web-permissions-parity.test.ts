import { describe, expect, it } from 'vitest';
import { canWrite, canWriteRepo } from '../apps/web/src/lib/permissions';
import { buildQuery, unwrapList } from '../apps/web/src/lib/api';

describe('web permission parity (mirrors backend RoleRank admin|write)', () => {
  it('canWrite: admin/write true, read/null/undefined false', () => {
    expect(canWrite('admin')).toBe(true);
    expect(canWrite('write')).toBe(true);
    expect(canWrite('read')).toBe(false);
    expect(canWrite(null)).toBe(false);
    expect(canWrite(undefined)).toBe(false);
  });

  it('canWriteRepo prefers viewerCanManage boolean, falls back to role', () => {
    expect(canWriteRepo({ viewerRole: 'read', viewerCanManage: true })).toBe(true);
    // OR semantics: explicit false does not veto an admin role.
    expect(canWriteRepo({ viewerRole: 'admin', viewerCanManage: false })).toBe(true);
    expect(canWriteRepo({ viewerRole: 'read', viewerCanManage: false })).toBe(false);
    expect(canWriteRepo({ viewerRole: 'write', viewerCanManage: undefined as never })).toBe(true);
    expect(canWriteRepo({ viewerRole: 'read', viewerCanManage: undefined as never })).toBe(false);
    expect(canWriteRepo(null)).toBe(false);
    expect(canWriteRepo(undefined)).toBe(false);
  });
});

describe('web api helpers', () => {
  it('buildQuery skips undefined/empty, repeats arrays', () => {
    const qs = buildQuery({ q: 'hello', empty: '', skip: undefined, tag: ['a', 'b'] });
    expect(qs).toContain('q=hello');
    expect(qs).toContain('tag=a');
    expect(qs).toContain('tag=b');
    expect(qs).not.toContain('skip');
    expect(qs).not.toContain('empty');
  });

  it('unwrapList returns [] for missing keys', () => {
    expect(unwrapList({}, 'items')).toEqual([]);
    expect(unwrapList({ items: [1, 2] }, 'items')).toEqual([1, 2]);
  });
});
