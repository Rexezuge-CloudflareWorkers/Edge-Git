// Re-export of the QuickJS wasm binary for the bundler.
// The binary is synced from the pinned npm package into
// `apps/background/wasm/` on postinstall (scripts/sync-quickjs-wasm.mjs).
// Wrangler bundles `.wasm` imports as WebAssembly.Module instances; tsc
// cannot resolve them, hence the expectation below. Consumers must
// dynamic-import this shim inside try/catch: node/vitest cannot load `.wasm`
// and must fall back to quickjs-emscripten's default loader.
// @ts-expect-error: `.wasm` is a bundler asset, invisible to tsc by design.
export { default } from '../../wasm/quickjs-async.wasm';
