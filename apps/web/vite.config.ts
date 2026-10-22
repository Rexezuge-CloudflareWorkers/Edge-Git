import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { spaShellEmbedPlugin } from '@rexezuge/tooling/vite';

const apiTarget = 'http://localhost:8787';

// The repository root, as the shell-embed plugin resolves its paths against.
// The build runs with the *package* directory as its working directory
// (`pnpm --filter @edge-git/web build` runs the script in `apps/web`), so the
// root is named rather than assumed.
const repoRoot = path.resolve(__dirname, '../..');

// `/search` and `/snippets` are both SPA routes and API prefixes. Document
// navigations (Accept: text/html) must keep serving index.html; only data
// fetches proxy to the worker. `/users` needs no bypass: no SPA route shares
// the prefix (profiles live at `/:username`).
function apiProxy({ spaFallback = false }: { spaFallback?: boolean } = {}) {
  return {
    target: apiTarget,
    changeOrigin: true,
    ...(spaFallback && {
      bypass: (req: IncomingMessage) => (req.headers.accept?.includes('text/html') ? '/index.html' : undefined),
    }),
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // The shell embed is the kit's (`@rexezuge/tooling`'s
    // `spaShellEmbedPlugin`): the API worker serves `SPA_HTML` from a module in
    // its own source tree, and both that module and `dist/` are gitignored — so
    // a fresh clone gets an empty stub and every `GET /` returns a blank page
    // until someone runs a build.
    spaShellEmbedPlugin({
      root: repoRoot,
      path: 'apps/api/src/generated/spa-shell.ts',
      distIndex: path.join(repoRoot, 'apps/web/dist/index.html'),
    }),
  ],
  server: {
    proxy: {
      '/user': apiProxy(),
      '/users': apiProxy(),
      '/repos': apiProxy(),
      '/search': apiProxy({ spaFallback: true }),
      '/snippets': apiProxy({ spaFallback: true }),
      '/realtime': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
