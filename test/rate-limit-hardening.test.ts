import { describe, expect, it } from 'vitest';
import { rateLimit } from '@/middleware';
import { clientIp } from '@rexezuge/http';

function makeCtx(headers: Record<string, string | null> = {}, identity?: string) {
  return {
    req: {
      header: (name: string) => headers[name] ?? null,
    },
    get: () => {
      if (identity === undefined) throw new Error('no scope');
      return identity;
    },
    json: (body: unknown, status: number, hdrs?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: hdrs }),
  } as never;
}

/**
 * Each `it` builds its own limiter, which is the point of the kit's design: the
 * bucket map lives in the limiter's closure, so a fresh `rateLimit(...)` starts
 * empty. There is no module-level bucket map left to reset between specs, and
 * no `resetRateLimitForTests` seam to remember to call.
 */
describe('rate-limit hardening', () => {
  it('prefers CF-Connecting-IP over spoofable X-Forwarded-For', () => {
    const c = makeCtx({ 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '9.9.9.9' });
    expect(clientIp((name) => c.req.header(name))).toBe('1.2.3.4');
  });

  it('does NOT trust spoofable X-Forwarded-For (fail-closed grouping)', () => {
    const c = makeCtx({ 'X-Forwarded-For': ' 5.6.7.8, 1.1.1.1' });
    expect(clientIp((name) => c.req.header(name))).toBe('unknown');
  });

  it('returns unknown with no ip headers', () => {
    expect(clientIp((name) => makeCtx().req.header(name))).toBe('unknown');
  });

  it('isolates buckets by authenticated identity, not just ip', async () => {
    const guard = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'iso-test' });
    const next = async () => undefined;
    await guard(makeCtx({}, 'alice@example.com'), next as never);
    // Same IP but different identity gets its own bucket.
    const second = await guard(makeCtx({}, 'bob@example.com'), next as never);
    expect(second).toBeUndefined();
    // Same identity again is limited, and answers with the family's envelope.
    const limited = (await guard(makeCtx({}, 'alice@example.com'), next as never)) as Response;
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toMatch(/^\d+$/);
    await expect(limited.json()).resolves.toMatchObject({ Exception: { Type: 'RateLimited' } });
  });

  it('keeps bucket count bounded under a flood of distinct identities', async () => {
    const guard = rateLimit({ windowMs: 60_000, max: 1, keyPrefix: 'flood-test' });
    const next = async () => undefined;
    // Fill past the hard cap with distinct identities.
    for (let i = 0; i < 5100; i += 1) {
      await guard(makeCtx({}, `user-${i}@example.com`), next as never);
    }
    // The cap evicts **oldest-first** rather than clearing the map, so the
    // earliest bucket is gone (served fresh) while the most recent one is still
    // being enforced. "Clear everything" would also bound memory, and would
    // let a flood reset every legitimate caller's budget at once.
    const oldest = await guard(makeCtx({}, 'user-0@example.com'), next as never);
    expect(oldest).toBeUndefined();
    const newest = (await guard(makeCtx({}, 'user-5099@example.com'), next as never)) as Response;
    expect(newest.status).toBe(429);
    const fresh = await guard(makeCtx({}, 'user-5100@example.com'), next as never);
    expect(fresh).toBeUndefined();
  });

  it('resets window after expiry', async () => {
    const guard = rateLimit({ windowMs: 1, max: 1, keyPrefix: 'window-test' });
    let calls = 0;
    const next = async () => {
      calls += 1;
    };
    await guard(makeCtx({}, 'w@example.com'), next as never);
    await new Promise((r) => setTimeout(r, 5));
    await guard(makeCtx({}, 'w@example.com'), next as never);
    expect(calls).toBe(2);
  });

  it('rejects a misconfigured limiter at registration instead of installing an unlimited one', () => {
    expect(() => rateLimit({ windowMs: 0, max: 1, keyPrefix: 'x' })).toThrow(/windowMs/);
    expect(() => rateLimit({ windowMs: 1000, max: 0, keyPrefix: 'x' })).toThrow(/max/);
    expect(() => rateLimit({ windowMs: 1000, max: 1, keyPrefix: '  ' })).toThrow(/keyPrefix/);
  });
});