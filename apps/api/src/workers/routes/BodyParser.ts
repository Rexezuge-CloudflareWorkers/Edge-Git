import type { Context } from 'hono';

type JsonContext = {
  req: { json: () => Promise<unknown> };
};

/**
 * Strict JSON body reader: distinguishes malformed JSON (`malformed: true`)
 * from a valid empty object. Callers must return 400 on malformed instead of
 * collapsing to `{}` and surfacing a misleading `required` error.
 * Non-object JSON (null, array, string, number) is malformed — callers
 * expecting an object must not coerce it to `{}`.
 * BREAKING: oversized JSON bodies (Content-Length > 1MB) are malformed so
 * large issue/PR bodies rely on service caps instead of unbounded parses.
 */
const MAX_JSON_BYTES = 1_000_000;

async function readJsonBody<T>(c: JsonContext | Context): Promise<{ malformed: boolean; body: T }> {
  try {
    try {
      const lenHeader = (c as Context).req?.header?.('content-length');
      if (lenHeader !== undefined) {
        const len = Number(lenHeader);
        if (Number.isSafeInteger(len) && len > MAX_JSON_BYTES) return { malformed: true, body: {} as T };
      }
    } catch {
      // Header check must never fail the read.
    }
    const body = (await (c as JsonContext).req.json()) as T;
    const value: unknown = body;
    if (value === null || value === undefined) return { malformed: true, body: {} as T };
    if (typeof value !== 'object' || Array.isArray(value)) return { malformed: true, body: {} as T };
    return { malformed: false, body };
  } catch {
    return { malformed: true, body: {} as T };
  }
}

export { readJsonBody, MAX_JSON_BYTES };
