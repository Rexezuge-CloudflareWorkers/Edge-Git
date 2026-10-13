import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const apiSrcPath = fileURLToPath(new URL('apps/api/src', import.meta.url));
const backgroundSrcPath = fileURLToPath(new URL('apps/background/src', import.meta.url));
const backendDataSrcPath = fileURLToPath(new URL('packages/backend-data/src', import.meta.url));
const backendRuntimeSrcPath = fileURLToPath(new URL('packages/backend-runtime/src', import.meta.url));
const gitProtocolSrcPath = fileURLToPath(new URL('packages/git-protocol/src', import.meta.url));
const gitServiceSrcPath = fileURLToPath(new URL('packages/git-service/src', import.meta.url));
const sharedSrcPath = fileURLToPath(new URL('packages/shared/src', import.meta.url));
const backendServicesSrcPath = fileURLToPath(new URL('packages/backend-services/src', import.meta.url));
const cloudflareSocketsMockPath = fileURLToPath(new URL('test/mocks/cloudflare-sockets.ts', import.meta.url));
const cloudflareWorkersMockPath = fileURLToPath(new URL('test/mocks/cloudflare-workers.ts', import.meta.url));
const cloudflareWorkflowsMockPath = fileURLToPath(new URL('test/mocks/cloudflare-workflows.ts', import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['test/integration/**'],
    server: {
      deps: {
        /**
         * The kit's `AbstractDurableObjectWorker` extends the real
         * `DurableObject` from `cloudflare:workers`, a specifier only the
         * Workers runtime provides.
         *
         * Consumed from `link:` this was a non-issue: the package resolved to a
         * path outside the project, so Vite processed it and the `cloudflare:`
         * aliases below applied. As an npm dependency it lives inside
         * `node_modules`, where Vite externalizes it for SSR and hands the file
         * to Node's ESM loader — which sees `cloudflare:workers`, has no such
         * protocol, and throws before a single test runs. Inlining hands the
         * file back to Vite so the aliases reach it, exactly as they always
         * did.
         *
         * The same goes for `@rexezuge/web`, which imports `react` as a peer:
         * externalized, a second React can be loaded from the package's own
         * resolution path and hooks read a different dispatcher than the
         * renderer.
         */
        inline: [/@rexezuge\//],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['apps/api/src/**/*.ts', 'apps/background/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/index.ts', '**/types.d.ts', '**/model/**'],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 85,
        lines: 88,
      },
    },
  },
  resolve: {
    alias: [
      { find: /^@edge-git\/background$/, replacement: `${backgroundSrcPath}/index.ts` },
      { find: /^@edge-git\/backend-data$/, replacement: `${backendDataSrcPath}/index.ts` },
      { find: /^@edge-git\/backend-runtime$/, replacement: `${backendRuntimeSrcPath}/index.ts` },
      { find: /^@edge-git\/backend-services$/, replacement: `${backendServicesSrcPath}/index.ts` },
      { find: /^@edge-git\/git-protocol$/, replacement: `${gitProtocolSrcPath}/index.ts` },
      { find: /^@edge-git\/git-service$/, replacement: `${gitServiceSrcPath}/index.ts` },
      { find: /^@edge-git\/shared$/, replacement: `${sharedSrcPath}/index.ts` },
      { find: '@edge-git/background', replacement: backgroundSrcPath },
      { find: '@edge-git/backend-data', replacement: backendDataSrcPath },
      { find: '@edge-git/backend-runtime', replacement: backendRuntimeSrcPath },
      { find: '@edge-git/backend-services', replacement: backendServicesSrcPath },
      { find: '@edge-git/git-protocol', replacement: gitProtocolSrcPath },
      { find: '@edge-git/git-service', replacement: gitServiceSrcPath },
      { find: '@edge-git/shared', replacement: sharedSrcPath },
      { find: 'cloudflare:sockets', replacement: cloudflareSocketsMockPath },
      { find: 'cloudflare:workers', replacement: cloudflareWorkersMockPath },
      { find: 'cloudflare:workflows', replacement: cloudflareWorkflowsMockPath },
      { find: /^@\//, replacement: `${apiSrcPath}/` },
    ],
  },
});
