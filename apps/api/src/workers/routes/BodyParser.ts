import type { Context } from 'hono';

type JsonContext = {
  req: { json: () => Promise<unknown> };
};

/**
 * Strict JSON body reader: distinguishes malformed JSON (`malformed: true`)
 * from a valid empty object. Callers must return 400 on malformed instead of
 * collapsing to `{}` and surfacing a misleading `required` error.
 */
async function readJsonBody<T>(c: JsonContext | Context): Promise<{ malformed: boolean; body: T }> {
  try {
    const body = (await (c as JsonContext).req.json()) as T;
    const value: unknown = body;
    if (value === null || value === undefined) return { malformed: false, body: {} as T };
    if (typeof value !== 'object') return { malformed: false, body: {} as T };
    return { malformed: false, body };
  } catch {
    return { malformed: true, body: {} as T };
  }
}

export { readJsonBody };
