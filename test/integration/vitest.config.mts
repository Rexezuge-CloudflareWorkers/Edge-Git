import { defineConfig } from 'vitest/config';
import { cloudflareTest, cloudflarePool } from '@cloudflare/vitest-pool-workers';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceAliases } from '@rexezuge/tooling/vitest-aliases';

// The workspace alias table is the kit's (`@rexezuge/tooling`'s
// `workspaceAliases`), so the integration suite resolves `@edge-git/*` exactly
// as the unit suite does. A suite resolving a workspace import differently from
// its sibling fails in a way that looks like a product bug.
//
// The harness wiring stays this repo's: the workerd plugin and pool, the
// migration SQL defines, and the coverage block (whose thresholds are
// omitted on purpose — V8 coverage instrumentation does not work inside the
// Cloudflare Workers sandbox).
const migrationsDir = resolve(fileURLToPath(new URL('../../migrations', import.meta.url)));
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
// File boundaries must survive into the test runtime: D1 PRAGMAs are
// transaction-scoped, so migration 0028 can only rely on
// `PRAGMA foreign_keys = off` if each file is applied in its own transaction.
const migrationFileList = migrationFiles.map((name) => ({ name, sql: readFileSync(resolve(migrationsDir, name), 'utf-8') }));
const migrationSql = migrationFileList.map((f) => f.sql).join('\n\n');

export default defineConfig({
  define: {
    __INTEGRATION_MIGRATION_SQL__: JSON.stringify(migrationSql),
    __INTEGRATION_MIGRATION_FILES__: JSON.stringify(migrationFileList),
  },
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './test/integration/wrangler.test.jsonc',
      },
    }),
  ],
  test: {
    globals: true,
    include: ['test/integration/**/*.int.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage-integration',
      include: ['apps/api/src/**/*.ts', 'apps/background/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.int.test.ts', '**/*.d.ts', '**/index.ts', '**/types.d.ts'],
      // NOTE: V8 coverage instrumentation is not functional with @cloudflare/vitest-pool-workers
      // because the Cloudflare Workers sandbox does not expose node:inspector/promises.
      // Run `pnpm run test:integration` (without --coverage) for integration testing.
      // Coverage thresholds are omitted intentionally — they would always fail at 0%.
    },
    pool: cloudflarePool({
      wrangler: {
        configPath: './test/integration/wrangler.test.jsonc',
      },
    }),
  },
  ssr: {
    noExternal: ['hono', 'chanfana', '@edge-git'],
  },
  resolve: {
    alias: workspaceAliases({
      scope: '@edge-git',
      root: new URL('../../', import.meta.url).href,
      mocks: [],
    }),
  },
});
