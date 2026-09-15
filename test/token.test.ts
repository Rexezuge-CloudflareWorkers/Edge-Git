import { describe, expect, it } from 'vitest';
import { TokenService } from '@edge-git/backend-services/auth';

describe('TokenService hashing', () => {
  it('hashes deterministically and differs per token', async () => {
    const a = await TokenService.hashToken('abc');
    const b = await TokenService.hashToken('abc');
    const c = await TokenService.hashToken('abd');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
