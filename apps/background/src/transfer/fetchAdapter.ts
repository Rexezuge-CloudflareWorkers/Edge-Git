import { normalizePublicGitUrl } from '@edge-git/git-protocol';
import type { RemoteGitFetcher } from '@edge-git/git-protocol';

// Production `RemoteGitFetcher` over the global `fetch`. Redirects are
// handled manually (max 3 hops) with the SSRF guard applied to every hop
// before following, so a public hostname cannot bounce the request at a
// private or loopback address (no TOCTOU: the private request never fires).
const MAX_REDIRECT_HOPS = 3;

function assertPublicFinalUrl(finalUrl: string): void {
  normalizePublicGitUrl(finalUrl.split('?', 1)[0]);
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function fetchNoAutoRedirect(url: string, init: RequestInit): Promise<Response> {
  let current = url;
  let currentInit: RequestInit = { ...init, redirect: 'manual' };
  // Cycle detection: A→B→A redirect loops otherwise burn all 3 hops before
  // surfacing as a generic limit error. Fail fast with a clear message.
  const visited = new Set<string>();
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    assertPublicFinalUrl(current.split('?', 1)[0]);
    if (visited.has(current)) {
      throw new Error(`redirect loop detected at ${current.split('?', 1)[0]}`);
    }
    visited.add(current);
    const res = await fetch(current, currentInit);
    if (!isRedirect(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    if (hop === MAX_REDIRECT_HOPS) {
      await res.arrayBuffer().catch(() => undefined);
      throw new Error(`too many redirects (limit ${MAX_REDIRECT_HOPS})`);
    }
    const next = new URL(location, current).href;
    assertPublicFinalUrl(next.split('?', 1)[0]);
    current = next;
    // Per fetch spec, 301/302/303 convert POST to GET (except 307/308).
    if ([301, 302, 303].includes(res.status)) {
      const { ...rest } = currentInit;
      delete rest.method;
      delete rest.body;
      currentInit = { ...rest, redirect: 'manual' };
    }
    await res.arrayBuffer().catch(() => undefined);
  }
  throw new Error(`too many redirects (limit ${MAX_REDIRECT_HOPS})`);
}

function workerFetchAdapter(): RemoteGitFetcher {
  return {
    async get(url: string, headers: Record<string, string>, signal: AbortSignal) {
      const res = await fetchNoAutoRedirect(url, { headers, signal });
      // Validate the URL we actually requested (`current`), not the
      // runtime-reported `Response.url` which may normalize differently.
      // fetchNoAutoRedirect already validated every hop pre-request.
      return { status: res.status, contentType: res.headers.get('content-type'), body: new Uint8Array(await res.arrayBuffer()) };
    },
    async post(url: string, headers: Record<string, string>, body: Uint8Array, signal: AbortSignal) {
      const res = await fetchNoAutoRedirect(url, {
        method: 'POST',
        headers,
        body: body as unknown as BodyInit,
        signal,
      });
      return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
    },
  };
}

export { workerFetchAdapter };
