# Edge-Git — Web SPA

Scope: `apps/web/**`. Parent index: `../../AGENTS.md`.

- Vite + React 19 SPA (`src/main.tsx`: `BrowserRouter` → `SpaApp`). Build embeds `dist/index.html` into `apps/api/src/generated/spa-shell.ts` (Vite plugin `spa-shell-embed`; never edit generated file; `scripts/ensure-spa-shell-stub.mjs` creates the empty stub on install).
- `SpaApp.tsx` — thin composition root: `useCurrentUser` + `useSpaLanguage` + `useNotice` hook slices, `Header`/`NoticeBar`, then `SpaViewRouter` (no data fetching in router).
- `components/layout/SpaViewRouter.tsx` — routes: `/` (Dashboard or Landing), `/new` (gated by `Unauthorized`), `/:owner/:repo` (`RepoView`), `/settings` (gated), `*` (localized 404 `Card`). Views in `src/views/`; repo tabs (`Code/Issues/Settings`), tokens UI, shared `ui/` primitives in `src/components/`.
- API access: `src/lib/api.ts` + `src/services/*` (`repo/issue/token/userService`) + `src/adapters/repoAdapter.ts`; `src/lib/format.ts`, `src/lib/constants.ts`, `src/types.ts` (facade re-exporting `repoTypes.ts` + `pullTypes.ts` + `collabTypes.ts` + `transferTypes.ts`).
- i18n: `src/i18n.ts` (i18next + `react-i18next`) — `SUPPORTED_LANGUAGES` (12 tags), single `canonicalizeLanguageTag` + `normalizeLanguage` (case/separator-insensitive, `zh` → `zh-CN`, unknown → `en`), `detectInitialLanguage` (stored `edge-git-lng` → `navigator.language` → `en`), `loadLanguage` (static `import.meta.glob` per-locale chunks). Bundles shipped: `src/locales/en|zh-CN/translation.json`. `src/lib/locale.ts` delegates canonicalization to `i18n` and adds `normalizeLocale`/`resolveLocale`/formatters on top (no duplicated logic).
- `components/repo/useCodeTabOverview.ts` — `CodeTab` overview data slice (aggregate overview RPC + lazy enrichment + inflight sharing) + single-sourced `resolveSelectedRef`/`mergeEnrichedEntries` helpers.
- English UI text uses Title Case (`Sign In To Create Repositories.`); keep `{{placeholder}}` parity across locales. Validate with `pnpm run validate:locales` (key/placeholder parity vs `en`, no empty values).
- Pure helpers are unit-tested from the root suite (`src/lib/threads.ts` gate parity/grouping via `test/web-threads.test.ts`); no component tests yet (see `docs/agents/testing/AGENTS.md`).
