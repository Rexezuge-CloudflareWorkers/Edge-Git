# Edge-Git

Self-hosted Git forge on Cloudflare Workers + Durable Objects + D1, structured like Otter/AWS-AccessBridge, with Git protocol logic ported from Gitflare.

- **Git Smart HTTP**: `GET /:owner/:repo/info/refs`, `POST /:owner/:repo/git-upload-pack`, `POST /:owner/:repo/git-receive-pack` (v2 upload, v0 receive, sideband-64k).
- **Storage**: one Durable Object (`RepoWorker`) per repo, virtual FS (`dofs` 512KB chunks, 5GB) + `isomorphic-git`; metadata in D1 (`users`, `repositories`, `user_access_tokens`, `issues`, `comments`).
- **Auth**: `/user/*` via Cloudflare Access (`cf-access-jwt-assertion` → `POLICY_AUD`/`TEAM_DOMAIN`, `ctx.access` fallback, `DEV_AUTH_EMAIL` local bypass); git via anonymous (public fetch only) or scoped PAT Basic/Bearer (owner-only v1). PATs minted at `/user/tokens` with scopes `repo:read` (fetch), `repo:write` (push), `admin` (both; hierarchy `admin` > `write` > `read`). Legacy tokens without scopes keep full access.
- **Branch protection**: per-repo rules (`POST /user/repos/:owner/:repo/rules`, `admin`-only) with `*` glob patterns, `require_pr`, `required_approvals` (0-6, PR creator self-approval never counts), `block_force_push` (ancestry-checked in the DO), `block_deletion`. Rules apply to everyone including admins (delete the rule to push directly); `require_status_checks` is stored-but-ignored until CI exists. Merges into protected bases require the approval quorum (409 otherwise); direct pushes to `require_pr` branches fail per-ref in `report-status`.
- **UI**: Vite SPA served from the Worker (`/user/`), repo create/list, PAT manager, clone instructions.

## Quick start

```bash
pnpm install
pnpm -r typecheck && pnpm run lint && pnpm run test:coverage && pnpm run test:integration
pnpm --filter @edge-git/web build
cp apps/api/wrangler.template.jsonc wrangler.jsonc  # fill D1 id
pnpm exec wrangler d1 migrations apply --remote edge-git-db
pnpm exec wrangler deploy
```

Clone: `git clone https://<host>/<owner>/<repo>`; authenticated: `git clone https://<owner>:<PAT>@<host>/<owner>/<repo>`.

## Git limits

DoS guards (all tunable via vars, shown with defaults): fetch `MAX_FETCH_WANTS=64` wants / `MAX_FETCH_HAVES=512` haves per request, `MAX_FETCH_BODY_BYTES=1048576` request body; pack `MAX_PACK_OBJECTS=10000` objects / `MAX_PACK_BYTES=52428800` bytes each way; push `MAX_PUSH_COMMANDS=100` ref updates. Over-limit fetches fail with `ERR …` (`400`/`413`); over-limit pushes fail closed (`413` at the edge, `unpack …` report-status from the DO). The isomorphic-git object cache is cleared after every push and expires after `GIT_CACHE_TTL_SECONDS=3600`.

## CD vars

`WRANGLER_JSONC` (full file) or `WRANGLER_VARS_PATCH_JSON` e.g. `{"POLICY_AUD":"…","TEAM_DOMAIN":"https://….cloudflareaccess.com","SITE_URL":"https://git.example.com"}`.
