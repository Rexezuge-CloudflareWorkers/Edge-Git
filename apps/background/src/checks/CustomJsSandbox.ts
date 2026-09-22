import { shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import type { QuickJSHandle } from 'quickjs-emscripten';
import { validateWebhookUrl } from '@edge-git/backend-services/webhook';
import { getQuickJSModule } from './quickjsLoader';
import { MAX_FETCH_BODY_BYTES, MAX_FETCH_HEADERS } from './SandboxLimits';
import type { SandboxInput } from './SandboxLimits';
import type { SandboxResult } from './CustomJsSandboxTypes';
import {
  disposeBag,
  disposeQuietly,
  formatLoggedArgs,
  interpretReturn,
  isInterruptMessage,
  isPromiseStateShape,
  isRecord,
  newObjectFromRecord,
  newStringArray,
  own,
  safeDumpMessage,
  setStringProp,
  sliceText,
  stripTrailingDots,
  toSandboxResult,
} from './SandboxUtils';
import type { HandleBag } from './SandboxUtils';

export type { SandboxInput, SandboxLimits } from './SandboxLimits';
export type { CustomConclusion, SandboxResult } from './CustomJsSandboxTypes';

// Sandboxed execution for repo-defined custom check scripts (`.edgegit/`).
// Facade over SandboxUtils (pure handle/result helpers): this module owns
// only guest host wiring (listFiles/readFile/fetch/log) + eval lifecycle.
// Threat model: scripts are repo contents (author already has write+); the
// sandbox grants zero ambient authority: no credentials/timers, network only
// to allowlisted exact https hosts (webhook SSRF guard reused), CPU/memory/
// fetch/output caps bound abuse. Guest runs in QuickJS (separate heap).

export async function runCustomCheckScript(input: SandboxInput): Promise<SandboxResult> {
  const logs: string[] = [];
  let logBytes = 0;
  const appendLog = (line: string): void => {
    if (logBytes >= input.limits.maxLogBytes) return;
    const clipped = line.slice(0, 1000);
    logBytes += clipped.length;
    logs.push(clipped);
  };

  let module_: Awaited<ReturnType<typeof getQuickJSModule>>;
  try {
    module_ = await getQuickJSModule();
  } catch (error) {
    return toSandboxResult(
      'action_required',
      'Sandbox Unavailable',
      `Could not load the JS sandbox: ${error instanceof Error ? error.message : 'unknown error'}`,
      logs,
    );
  }

  const runtime = module_.newRuntime();
  runtime.setMemoryLimit(Math.max(4, input.limits.memoryMb) * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + Math.max(100, input.limits.cpuMs)));
  const ctx = runtime.newContext();
  const bag: HandleBag = [];
  let fetchCount = 0;

  const failTeardown = (title: string, summary: string): SandboxResult => {
    disposeBag(bag);
    disposeQuietly(ctx, runtime);
    return toSandboxResult('action_required', title, summary, logs);
  };

  try {
    const api = own(bag, ctx.newObject());
    const envObj = newObjectFromRecord(ctx, bag, input.env);
    ctx.setProp(api, 'env', envObj);
    const paths = Object.keys(input.files);
    // Host implementations return promises (required by newAsyncifiedFunction)
    // but perform no awaits of their own; asyncify still presents them to the
    // guest as synchronous blocking calls.
    const listFiles = own(
      bag,
      ctx.newAsyncifiedFunction('listFiles', () => Promise.resolve(newStringArray(ctx, bag, paths))),
    );
    ctx.setProp(api, 'listFiles', listFiles);
    // readFile(path) -> string | null (preloaded, capped contents only).
    // Note: returned handles transfer to the guest — never bag them.
    const readFile = own(
      bag,
      ctx.newAsyncifiedFunction('readFile', (pathHandle?: QuickJSHandle) => {
        if (pathHandle === undefined) return Promise.resolve(ctx.null);
        let path: string;
        try {
          const raw: unknown = ctx.getString(pathHandle);
          if (typeof raw !== 'string') return Promise.resolve(ctx.null);
          path = raw;
        } catch {
          return Promise.resolve(ctx.null);
        }
        if (path.length > 1024) return Promise.resolve(ctx.null);
        const content: unknown = input.files[path];
        if (typeof content !== 'string') return Promise.resolve(ctx.null);
        return Promise.resolve(ctx.newString(content));
      }),
    );
    ctx.setProp(api, 'readFile', readFile);
    // fetch(url, opts?) — allowlisted exact https hosts only, counted + capped.
    const guestFetch = own(
      bag,
      ctx.newAsyncifiedFunction('fetch', async (urlHandle?: QuickJSHandle, optsHandle?: QuickJSHandle) => {
        // Error-variant handles transfer to the guest like normal returns.
        const fail = (message: string): { error: QuickJSHandle } => ({ error: ctx.newString(message) });
        let rawUrl: unknown;
        try {
          rawUrl = urlHandle === undefined ? undefined : ctx.getString(urlHandle);
        } catch {
          return fail('fetch(url) requires a string URL');
        }
        if (typeof rawUrl !== 'string' || !rawUrl.trim()) return fail('fetch(url) requires a string URL');
        const url = rawUrl.trim();
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          return fail('fetch(url) must be an absolute URL');
        }
        if (parsed.protocol !== 'https:') return fail('fetch(url) must use https');
        // Canonicalize before allowlist compare: lowercase + strip trailing
        // dot so `Example.COM.` cannot bypass `example.com`. Hostname
        // excludes port by design (URL.hostname), so ports are intentionally
        // not part of the allowlist — same host, any port.
        const canonicalHost = stripTrailingDots(parsed.hostname.toLowerCase());
        const allowListed = input.allowHosts.map((h) => stripTrailingDots(h.toLowerCase())).includes(canonicalHost);
        if (!allowListed) return fail(`fetch blocked: ${parsed.hostname} is not in allowHosts`);
        try {
          validateWebhookUrl(url);
        } catch {
          return fail('fetch blocked: URL targets a loopback, private, or reserved address');
        }
        fetchCount += 1;
        if (fetchCount > input.limits.maxFetches) return fail(`fetch blocked: at most ${input.limits.maxFetches} fetches per run`);
        let method = 'GET';
        let body: string | undefined;
        const headers: Record<string, string> = {};
        if (optsHandle !== undefined) {
          const opts = ctx.dump(optsHandle);
          if (!isRecord(opts)) return fail('fetch(url, opts) opts must be an object');
          if (opts.method !== undefined) {
            if (opts.method !== 'GET' && opts.method !== 'POST') return fail('fetch opts.method must be GET or POST');
            method = opts.method;
          }
          if (opts.headers !== undefined) {
            if (!isRecord(opts.headers)) return fail('fetch opts.headers must be an object');
            const entries = Object.entries(opts.headers);
            if (entries.length > MAX_FETCH_HEADERS) return fail(`fetch opts.headers must have at most ${MAX_FETCH_HEADERS} entries`);
            for (const [key, value] of entries) {
              if (typeof value !== 'string') return fail('fetch header values must be strings');
              headers[key.slice(0, 256)] = value.slice(0, 4096);
            }
          }
          if (opts.body !== undefined) {
            if (typeof opts.body !== 'string') return fail('fetch opts.body must be a string');
            if (opts.body.length > MAX_FETCH_BODY_BYTES) return fail(`fetch opts.body must be at most ${MAX_FETCH_BODY_BYTES} chars`);
            body = opts.body;
          }
        }
        try {
          const response = await fetch(url, {
            method,
            headers,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(input.limits.fetchTimeoutMs),
          });
          const length = Number(response.headers.get('content-length'));
          if (Number.isSafeInteger(length) && length > input.limits.maxResponseBytes) {
            return fail(`fetch blocked: response larger than ${input.limits.maxResponseBytes} bytes`);
          }
          const text = await response.text();
          const result = ctx.newObject();
          try {
            const statusHandle = own(bag, ctx.newNumber(response.status));
            ctx.setProp(result, 'status', statusHandle);
            setStringProp(ctx, bag, result, 'body', sliceText(text, input.limits.maxResponseBytes));
            return result;
          } catch (error) {
            result.dispose();
            throw error;
          }
        } catch (error) {
          if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return fail('fetch timed out');
          return fail(`fetch failed: ${error instanceof Error ? error.message.slice(0, 200) : 'network error'}`);
        }
      }),
    );
    ctx.setProp(api, 'fetch', guestFetch);
    // log(...args) + console.log(...args) — captured into the run summary.
    const makeLogFn = (): QuickJSHandle =>
      own(
        bag,
        ctx.newAsyncifiedFunction('log', (...args) => {
          appendLog(formatLoggedArgs(ctx, args));
          return Promise.resolve();
        }),
      );
    const logFn = makeLogFn();
    ctx.setProp(api, 'log', logFn);
    const consoleObj = own(bag, ctx.newObject());
    const consoleLog = makeLogFn();
    ctx.setProp(consoleObj, 'log', consoleLog);
    ctx.setProp(api, 'console', consoleObj);

    // Guest contract: `async function main(ctx) { ... return { conclusion,
    // title?, summary? } }`. Host fns are async — always await them. Only
    // __ctx and console cross the boundary.
    ctx.setProp(ctx.global, '__ctx', api);
    const consoleApi = own(bag, ctx.getProp(api, 'console'));
    ctx.setProp(ctx.global, 'console', consoleApi);
  } catch (error) {
    return failTeardown('Sandbox Setup Failed', error instanceof Error ? error.message.slice(0, 500) : 'Failed to build the sandbox.');
  }

  // Guest contract: `function main(ctx)` MUST be synchronous and return
  // `{ conclusion, title?, summary? }`. Host calls (readFile, fetch, ...)
  // already block via asyncify — awaiting them suspends the VM forever, so
  // the guard below rejects async/promise mains synchronously with a clear
  // message instead of hanging until the wall watchdog fires.
  const source = `${input.script}\n;(function () {\n  const result = main(__ctx);\n  if (result && typeof result.then === 'function') throw new Error('main(ctx) must be synchronous: return { conclusion } directly and never await host calls (they already block).');\n  return result;\n})();`;
  let settled: SandboxResult;
  let abandoned = false;
  try {
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    const wallTimeout = new Promise<never>((_, reject) => {
      wallTimer = setTimeout(() => reject(new Error('__wall_timeout__')), Math.max(1000, input.limits.wallMs));
    });
    let outcome: { error?: QuickJSHandle; value?: QuickJSHandle };
    try {
      outcome = await Promise.race([ctx.evalCodeAsync(source, 'check.js'), wallTimeout]);
    } finally {
      if (wallTimer) clearTimeout(wallTimer);
    }
    if (outcome.error) {
      const message = safeDumpMessage(ctx, outcome.error);
      outcome.error.dispose();
      settled = isInterruptMessage(message)
        ? toSandboxResult('timed_out', 'Check Timed Out', `Exceeded the ${input.limits.cpuMs}ms CPU budget.`, logs)
        : toSandboxResult('failure', 'Check Script Threw', message, logs);
    } else if (outcome.value) {
      const dumped = ctx.dump(outcome.value);
      if (isPromiseStateShape(dumped)) {
        // Defensive: the sync guard above should make this unreachable, but a
        // promise-state handle must never be disposed (it aborts the runtime),
        // so abandon instead of risking teardown.
        abandoned = true;
        settled = toSandboxResult(
          'action_required',
          'Check Did Not Settle',
          'main(ctx) must be synchronous and return { conclusion, title?, summary? }.',
          logs,
        );
      } else {
        outcome.value.dispose();
        settled = interpretReturn(dumped, logs);
      }
    } else {
      settled = toSandboxResult(
        'action_required',
        'Check Returned Nothing',
        'main(ctx) must return { conclusion, title?, summary? }.',
        logs,
      );
    }
  } catch (error) {
    settled =
      error instanceof Error && error.message === '__wall_timeout__'
        ? ((abandoned = true), toSandboxResult('timed_out', 'Check Timed Out', `Exceeded the ${input.limits.wallMs}ms wall budget.`, logs))
        : toSandboxResult(
            'action_required',
            'Sandbox Error',
            error instanceof Error ? error.message.slice(0, 500) : 'Sandbox execution failed.',
            logs,
          );
  }

  // Abandoned runs skip teardown: suspended asyncify state cannot be unwound
  // safely (disposing it aborts the runtime), so leak this runtime rather
  // than risk the isolate. The run is already timed_out; the cron stale task
  // bounds any D1 fallout.
  if (!abandoned) {
    try {
      const scrub = ctx.evalCode('delete globalThis.__ctx; delete globalThis.console;');
      (scrub.error ?? scrub.value).dispose();
    } catch {
      // Best-effort scrub; context dispose still frees guest memory.
    }
    disposeBag(bag);
    disposeQuietly(ctx, runtime);
  }
  return settled;
}
