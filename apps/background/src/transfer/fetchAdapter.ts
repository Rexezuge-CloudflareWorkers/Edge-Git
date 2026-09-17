import { normalizePublicGitUrl } from '@edge-git/git-protocol';
import type { RemoteGitFetcher } from '@edge-git/git-protocol';

// Production `RemoteGitFetcher` over the global `fetch`. Follows redirects
// but re-validates the final URL so a public hostname cannot bounce the
// request at a private or loopback address.
function assertPublicFinalUrl(finalUrl: string): void {
  normalizePublicGitUrl(finalUrl.split('?', 1)[0]);
}

function workerFetchAdapter(): RemoteGitFetcher {
  return {
    async get(url: string, headers: Record<string, string>, signal: AbortSignal) {
      const res = await fetch(url, { headers, signal});
      assertPublicFinalUrl(res.url || url);
      return { status: res.status, contentType: res.headers.get('content-type'), body: new Uint8Array(await res.arrayBuffer()) };
    },
    async post(url: string, headers: Record<string, string>, body: Uint8Array, signal: AbortSignal) {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: body as unknown as BodyInit,
        signal,
      });
      assertPublicFinalUrl(res.url || url);
      return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
    },
  };
}

export { workerFetchAdapter };
