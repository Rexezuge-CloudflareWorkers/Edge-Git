import { defineUnitVitestConfig } from '@rexezuge/tooling/vitest';

// The unit-suite config is the kit's (`@rexezuge/tooling`'s
// `defineUnitVitestConfig`): the workspace alias table, the `cloudflare:*`
// mock aliases, the React dedupe, and the coverage block that reports every
// matching file whether or not a test imported it.
//
// What this repo supplies is what the kit cannot know: the scope, the floors,
// and the two ways this tree differs from the canonical one — the SPA suites
// run here rather than in a sibling project (the `// @vitest-environment jsdom`
// pragma picks the DOM per file), and the integration suite is a separate
// config rather than an excluded shape.
export default defineUnitVitestConfig({
  scope: '@edge-git',
  root: new URL('.', import.meta.url).href,
  include: ['test/**/*.test.{ts,tsx}'],
  exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**'],
  thresholds: { statements: 85, branches: 75, functions: 85, lines: 88 },
});
