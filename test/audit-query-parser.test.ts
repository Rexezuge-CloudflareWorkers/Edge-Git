import { describe, expect, it } from 'vitest';
import { parseAuditQuery } from '@/workers/routes/AuditRoutes';

describe('parseAuditQuery (Number(null) trap)', () => {
  it('leaves time/limit filters unset when params are absent', () => {
    expect(parseAuditQuery('https://x/user/audit')).toEqual({});
    expect(parseAuditQuery('https://x/user/audit?limit=5')).toEqual({ limit: 5 });
  });

  it('parses explicit filters', () => {
    expect(parseAuditQuery('https://x/user/audit?startTime=100&endTime=200&limit=10&action=repo.list')).toEqual({
      startTime: 100,
      endTime: 200,
      limit: 10,
      action: 'repo.list',
    });
  });

  it('ignores non-numeric filters instead of coercing to 0', () => {
    expect(parseAuditQuery('https://x/user/audit?startTime=abc&limit=xyz')).toEqual({});
  });

  it('supports user_email alias and cursor passthrough', () => {
    const valid = btoa(JSON.stringify({ timestamp: 1, log_id: 'a' }));
    expect(parseAuditQuery(`https://x/user/audit?user_email=a@x.com&cursor=${valid}`)).toEqual({
      userEmail: 'a@x.com',
      cursor: valid,
    });
  });

  it('rejects tampered cursors instead of silently restarting', () => {
    expect(() => parseAuditQuery('https://x/user/audit?cursor=c1')).toThrow('Invalid cursor');
  });
});
