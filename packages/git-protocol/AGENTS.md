# Edge-Git — Git Protocol

Scope: `packages/git-protocol/**`. Parent index: `../../AGENTS.md`. Layer 2 (layer 0 only; no service/app imports).

- Role: pure Git Smart HTTP wire-protocol helpers shared by `apps/api` (advertise/auth-gate) and `apps/background` `RepoWorker` (pack fetch/push). No I/O, no D1/DO access. `apps/api` must use this package — never import `@edge-git/git-service` directly (ESLint-enforced).
- `src/pkt.ts` — `PktLine` pkt-line codec: `encode/decodeText/mergeLines`, `flush/delim/response-end` sentinels, `data/error` packets (protocol v2 framing).
- `src/protocol.ts` — barrel re-exporting the split modules below (import from `@edge-git/git-protocol` root, not deep paths):
  - `AdvertiseBuilder.ts` — `advertiseUploadPack()` (static v2 capabilities) / `advertiseReceivePack(listRefs)` (`report-status delete-refs atomic no-thin` + `symref`, zero-oid empty-repo line), `buildLsRefsResponse`.
  - `FetchParser.ts` / `FetchResponseBuilder.ts` — `parseFetchRequest`, `shouldSendPackfileForFetch`, `buildFetchResponse/ErrorResponse`, `validateFetchRequestCounts` (haves/wants/body limits → `413`).
  - `ReceiveParser.ts` — `parseReceivePackRequest`, `parseCommand`, `buildReportStatus`, `validateReceivePackCounts` (commands/pack limits → `413`).
  - `AuthHeaders.ts` — `getBasicCredentials` (Basic password = PAT) / `getBearerToken` (Bearer PAT) extraction.
- `src/types.ts` — shared wire types (`RefUpdateResult`).
- Limits wiring: `ConfigurationManager.repo.getMax*Bytes` supplies the `*Limits`; tests in `test/fetch-negotiation|git-limits|pkt|protocol*.test.ts`.
