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
 */
async function readJsonBody<T>(c: JsonContext | Context): Promise<{ malformed: boolean; body: T }> {
  try {
    const body = (await (c as JsonContext).req.json()) as T;
    const value: unknown = body;
    if (value === null || value === undefined) return { malformed: true, body: {} as T };
    if (typeof value !== 'object' || Array.isArray(value)) return { malformed: true, body: {} as T };
    return { malformed: false, body };
  } catch {
    return { malformed: true, body: {} as T };
  }
}

export { readJsonBody };
