import { RELEASE_ASYNC, newQuickJSAsyncWASMModule, newVariant } from 'quickjs-emscripten';
import type { QuickJSAsyncWASMModule } from 'quickjs-emscripten';

// Singleton QuickJS async module shared by all sandbox runs in this isolate.
// Runtimes and contexts stay per-execution (fresh globals per run); only the
// compiled WebAssembly module is shared, sidestepping v8's cap on live
// WebAssembly module instances.
//
// Loading: the wasm binary is synced from the pinned npm package into
// `apps/background/wasm/` on postinstall (scripts/sync-quickjs-wasm.mjs) so
// bundlers see a stable project-relative file. Wrangler bundles the `.wasm`
// import as a WebAssembly.Module; node/vitest/vite-based runners cannot load
// it, so failure falls through to the default loader (which reads the file
// from the package directory under node).
function memoizeModule(loader: () => Promise<QuickJSAsyncWASMModule>): () => Promise<QuickJSAsyncWASMModule> {
  let pending: Promise<QuickJSAsyncWASMModule> | undefined;
  return () => {
    if (pending === undefined) pending = loader();
    return pending;
  };
}

const getQuickJSModule = memoizeModule(async () => {
  try {
    const imported = await import(/* @vite-ignore */ './quickjsWasm');
    if (imported?.default) {
      return newQuickJSAsyncWASMModule(newVariant(RELEASE_ASYNC, { wasmModule: imported.default }));
    }
  } catch {
    // Fall through to the default loader.
  }
  return newQuickJSAsyncWASMModule();
});

export { getQuickJSModule };
