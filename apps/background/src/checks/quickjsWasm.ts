// Re-export of the QuickJS wasm binary for the bundler.
// The binary is synced from the pinned npm package into
// `apps/background/wasm/` on postinstall (scripts/sync-quickjs-wasm.mjs).
// Wrangler bundles `.wasm` imports as WebAssembly.Module instances and its
// `types` step (postinstall) declares `*.wasm` as WebAssembly.Module in
// worker-configuration.d.ts, so tsc resolves this import. Consumers must
// dynamic-import this shim inside try/catch: node/vitest cannot load `.wasm`
// and must fall back to quickjs-emscripten's default loader.
export { default } from '../../wasm/quickjs-async.wasm';
