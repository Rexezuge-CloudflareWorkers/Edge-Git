import { describe, expect, it } from 'vitest';

declare const __INTEGRATION_MIGRATION_SQL__: string;

describe('integration migrations', () => {
  it('embeds the D1 schema', () => {
    expect(typeof __INTEGRATION_MIGRATION_SQL__).toBe('string');
    expect(__INTEGRATION_MIGRATION_SQL__).toContain('CREATE TABLE IF NOT EXISTS repositories');
    expect(__INTEGRATION_MIGRATION_SQL__).toContain('user_access_tokens');
  });
});
