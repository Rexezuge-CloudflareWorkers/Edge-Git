import type { Context } from 'hono';

type JsonContext = {
  req: { json: () => Promise<unknown> };
};

/**
 * Strict JSON body reader: distinguishes malformed JSON (`malformed: true`)
 * from a valid empty object. Callers must check `oversized` first (413) then
 * `malformed` (400) — see `toBodyErrorStatus` — instead of collapsing to `{}`
 * and surfacing a misleading `required` error.
 * Non-object JSON (null, array, string, number) is malformed — callers
 * expecting an object must not coerce it to `{}`.
 * Oversized `Content-Length` is reported as `oversized: true` (alongside
 * `malformed: true` so legacy callers still fail closed with 400).
 * The default cap is 1MB; base64 upload routes pass a higher per-route cap
 * derived from their configured max bytes.
 */
const MAX_JSON_BYTES = 1_000_000;

type ReadJsonOptions = {
  maxBytes?: number;
};

type ReadJsonResult<T> = { malformed: boolean; oversized: boolean; body: T };

async function readJsonBody<T>(c: JsonContext | Context, opts?: ReadJsonOptions): Promise<ReadJsonResult<T>> {
  const limit = opts?.maxBytes ?? MAX_JSON_BYTES;
  try {
    try {
      const lenHeader = (c as Context).req?.header?.('content-length');
      if (typeof lenHeader === 'string') {
        const len = Number(lenHeader);
        if (Number.isSafeInteger(len) && len > limit) return { malformed: true, oversized: true, body: {} as T };
      }
    } catch {
      // Header check must never fail the read.
    }
    const body = (await (c as JsonContext).req.json()) as T;
    const value: unknown = body;
    if (value === null || value === undefined) return { malformed: true, oversized: false, body: {} as T };
    if (typeof value !== 'object' || Array.isArray(value)) return { malformed: true, oversized: false, body: {} as T };
    return { malformed: false, oversized: false, body };
  } catch {
    return { malformed: true, oversized: false, body: {} as T };
  }
}

/**
 * Central status mapper for `readJsonBody` results (why: 60+ callers
 * previously ignored `oversized`, masking 413 as 400). Returns 413 when
 * oversized, 400 when malformed, null when ok — callers map to `jsonError`.
 */
function toBodyErrorStatus(result: Pick<ReadJsonResult<unknown>, 'malformed' | 'oversized'>): 413 | 400 | null {
  if (result.oversized) return 413;
  if (result.malformed) return 400;
  return null;
}

export { readJsonBody, toBodyErrorStatus, MAX_JSON_BYTES };
export type { ReadJsonOptions, ReadJsonResult };
