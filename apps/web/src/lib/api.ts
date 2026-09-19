function extractErrorMessage(payloadText: string, status: number): string {
  if (!payloadText) return `HTTP ${status}`;
  try {
    const data = JSON.parse(payloadText) as {
      Exception?: { Type?: string; Message?: string };
      error?: string;
      message?: string;
    };
    // AWS envelope first, then legacy `{error,message}`, then raw text.
    const exceptionMessage = data?.Exception?.Message;
    if (typeof exceptionMessage === 'string' && exceptionMessage.length > 0) return exceptionMessage;
    const legacy = data?.message ?? data?.error;
    if (typeof legacy === 'string' && legacy.length > 0) return legacy;
    const type = data?.Exception?.Type;
    if (typeof type === 'string' && type.length > 0) return `${type} (HTTP ${status})`;
  } catch {
    // Plain-text body (git paths, proxies): surface as-is.
  }
  return payloadText || `HTTP ${status}`;
}

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(extractErrorMessage(text, response.status));
  }
  return response.json();
}

function buildQuery(params: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) p.append(key, v);
    } else {
      p.set(key, value);
    }
  }
  return p.toString();
}

export async function apiGet<T>(path: string, params?: Record<string, string | string[] | undefined>): Promise<T> {
  const qs = params ? buildQuery(params) : '';
  return readJson<T>(await fetch(qs ? `${path}?${qs}` : path));
}

export async function apiPost<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  return readJson<T>(
    await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export async function apiDelete<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { method: 'DELETE' }));
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiPost<T>(path, body, 'PATCH');
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiPost<T>(path, body, 'PUT');
}

export { buildQuery };

export function unwrapList<T>(data: Record<string, T[] | undefined>, key: string): T[] {
  return data[key] ?? [];
}

export async function apiAuthedFirst<T>(authedPath: string, publicPath: string, isAuthed?: boolean | null): Promise<T> {
  // Anonymous viewers hit Cloudflare Access on /user/* (302 → cross-origin
  // login HTML → CORS failure). Skip the wasted authed attempt entirely.
  if (isAuthed === false) {
    return apiGet<T>(publicPath);
  }
  try {
    return await apiGet<T>(authedPath);
  } catch {
    return apiGet<T>(publicPath);
  }
}
