import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const apiSrcPath = fileURLToPath(new URL('apps/api/src', import.meta.url));
const backgroundSrcPath = fileURLToPath(new URL('apps/background/src', import.meta.url));
const backendDataSrcPath = fileURLToPath(new URL('packages/backend-data/src', import.meta.url));
const backendErrorsSrcPath = fileURLToPath(new URL('packages/backend-errors/src', import.meta.url));
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
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: [
        'apps/api/src/**/*.ts',
        'apps/background/src/**/*.ts',
        'packages/**/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        '**/index.ts',
        '**/types.d.ts',
        '**/model/**',
      ],
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 50,
        lines: 50,
      },
    },
  },
  resolve: {
    alias: [
      { find: /^@edge-git\/background$/, replacement: `${backgroundSrcPath}/index.ts` },
      { find: /^@edge-git\/backend-data$/, replacement: `${backendDataSrcPath}/index.ts` },
      { find: /^@edge-git\/backend-errors$/, replacement: `${backendErrorsSrcPath}/index.ts` },
      { find: /^@edge-git\/backend-runtime$/, replacement: `${backendRuntimeSrcPath}/index.ts` },
      { find: /^@edge-git\/backend-services$/, replacement: `${backendServicesSrcPath}/index.ts` },
      { find: /^@edge-git\/git-protocol$/, replacement: `${gitProtocolSrcPath}/index.ts` },
      { find: /^@edge-git\/git-service$/, replacement: `${gitServiceSrcPath}/index.ts` },
      { find: /^@edge-git\/shared$/, replacement: `${sharedSrcPath}/index.ts` },
      { find: '@edge-git/background', replacement: backgroundSrcPath },
      { find: '@edge-git/backend-data', replacement: backendDataSrcPath },
      { find: '@edge-git/backend-errors', replacement: backendErrorsSrcPath },
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
