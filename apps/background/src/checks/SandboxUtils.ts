import type { QuickJSAsyncContext, QuickJSHandle } from 'quickjs-emscripten';
import { MAX_OUTPUT_SUMMARY, MAX_OUTPUT_TITLE } from './SandboxLimits';
import type { SandboxResult } from './CustomJsSandboxTypes';

type HandleBag = QuickJSHandle[];

const CUSTOM_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'failure', 'neutral', 'skipped']);

function own(bag: HandleBag, handle: QuickJSHandle): QuickJSHandle {
  bag.push(handle);
  return handle;
}

function sliceText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripTrailingDots(host: string): string {
  let end = host.length;
  while (end > 0 && host.charAt(end - 1) === '.') end -= 1;
  return host.slice(0, end);
}

function toSandboxResult(conclusion: SandboxResult['conclusion'], title: string, summary: string, logs: string[]): SandboxResult {
  const tail = logs.length > 0 ? `\nlogs:\n${logs.join('\n')}` : '';
  return { conclusion, title: sliceText(title, MAX_OUTPUT_TITLE), summary: sliceText(`${summary}${tail}`, MAX_OUTPUT_SUMMARY) };
}

function setStringProp(ctx: QuickJSAsyncContext, bag: HandleBag, obj: QuickJSHandle, key: string, value: string): void {
  const keyHandle = own(bag, ctx.newString(key));
  const valueHandle = own(bag, ctx.newString(value));
  ctx.setProp(obj, keyHandle, valueHandle);
}

function newObjectFromRecord(ctx: QuickJSAsyncContext, bag: HandleBag, record: Record<string, string>): QuickJSHandle {
  const obj = own(bag, ctx.newObject());
  for (const [key, value] of Object.entries(record)) setStringProp(ctx, bag, obj, key, value);
  return obj;
}

function newStringArray(ctx: QuickJSAsyncContext, bag: HandleBag, values: string[]): QuickJSHandle {
  const arr = own(bag, ctx.newArray());
  values.forEach((value, index) => {
    const item = own(bag, ctx.newString(value));
    ctx.setProp(arr, index, item);
  });
  return arr;
}

function disposeBag(bag: HandleBag): void {
  for (let index = bag.length - 1; index >= 0; index--) {
    try {
      bag[index]?.dispose();
    } catch {
      // Teardown must never throw.
    }
  }
  bag.length = 0;
}

function formatLoggedArgs(ctx: QuickJSAsyncContext, args: QuickJSHandle[]): string {
  return args
    .map((arg) => {
      try {
        const dumped = ctx.dump(arg);
        return typeof dumped === 'string' ? dumped : (JSON.stringify(dumped) ?? '?');
      } catch {
        return '?';
      }
    })
    .join(' ');
}

function disposeQuietly(ctx: QuickJSAsyncContext, runtime: { dispose(): void }): void {
  try {
    ctx.dispose();
  } catch {
    // Best-effort; runtime dispose still frees guest memory.
  }
  try {
    runtime.dispose();
  } catch {
    // Already-aborted runtimes throw here; the run result stands.
  }
}

function interpretReturn(dumped: unknown, logs: string[]): SandboxResult {
  const value = dumped;
  if (!isRecord(value))
    return toSandboxResult(
      'action_required',
      'Check Returned Nothing Usable',
      'main(ctx) must return { conclusion, title?, summary? }.',
      logs,
    );
  const conclusion = typeof value.conclusion === 'string' ? value.conclusion : null;
  if (conclusion === null || !CUSTOM_CONCLUSIONS.has(conclusion)) {
    return toSandboxResult(
      'action_required',
      'Check Returned A Bad Conclusion',
      'main(ctx) must return conclusion one of success, failure, neutral, skipped.',
      logs,
    );
  }
  const title = typeof value.title === 'string' && value.title.trim() ? value.title.trim() : `Custom Check ${conclusion}`;
  const summary = typeof value.summary === 'string' ? value.summary : '';
  return toSandboxResult(conclusion as SandboxResult['conclusion'], title, summary, logs);
}

// A dumped QuickJS promise ({ type: 'pending'|'fulfilled'|'rejected' }).
// Promise-state handles must never be disposed (it aborts the runtime), so
// callers abandon the runtime instead of tearing it down.
function isPromiseStateShape(dumped: unknown): boolean {
  return isRecord(dumped) && typeof dumped.type === 'string' && (['fulfilled', 'rejected', 'pending'] as string[]).includes(dumped.type);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '?';
  } catch {
    return '?';
  }
}

function safeDumpMessage(ctx: QuickJSAsyncContext, handle: QuickJSHandle): string {
  try {
    const dumped = ctx.dump(handle);
    if (typeof dumped === 'string') return dumped.slice(0, 500);
    if (isRecord(dumped)) {
      if (typeof dumped.message === 'string') return dumped.message.slice(0, 500);
      if (typeof dumped.name === 'string' && typeof dumped.message === 'string') return `${dumped.name}: ${dumped.message}`.slice(0, 500);
    }
    return stringifyUnknown(dumped).slice(0, 500);
  } catch {
    return 'Check script failed.';
  }
}

function isInterruptMessage(message: string): boolean {
  return /interrupted/i.test(message);
}

export {
  CUSTOM_CONCLUSIONS,
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
  stringifyUnknown,
  toSandboxResult,
};
export type { HandleBag };
