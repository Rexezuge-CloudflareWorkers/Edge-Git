import { createLogger } from './logger';

const logger = createLogger('Cache');

const CACHE_NAME = 'edge-git:json';
const CACHE_BASE_URL = 'https://edge-git.local';

async function getJsonCache(): Promise<Cache> {
  const cache = await caches.open(CACHE_NAME);
  return cache;
}

type Params = Record<string, string | undefined>;

type BuildCacheKeyArgs = {
  key: string;
  params: Params;
  baseUrl?: string;
};

function buildCacheKey({ key, params, baseUrl }: BuildCacheKeyArgs): URL {
  const path = key.startsWith('/') ? key : `/${key}`;
  const url = new URL(`/__cache${path}`, baseUrl ?? CACHE_BASE_URL);
  for (const param of Object.keys(params)) {
    const value = params[param];
    if (value) url.searchParams.set(param, value);
  }
  return url;
}

type PutJsonArgs<T> = {
  key: string;
  data: T;
  params?: Params;
  baseUrl?: string;
  options?: {
    ttlSeconds?: number;
  };
};

async function putJson<T>({ key, data, params, baseUrl, options }: PutJsonArgs<T>): Promise<void> {
  const ttl = options?.ttlSeconds ?? 60 * 60 * 24 * 365;
  const cache = await getJsonCache();
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': `public, max-age=${Math.floor(ttl)}`,
  });
  const response = new Response(JSON.stringify(data), { headers });
  const finalKey = buildCacheKey({ key, params: params ?? {}, baseUrl });
  await cache.put(finalKey, response);
  logger.debug(`Cached data for key: ${finalKey.toString()}`);
}

type GetJsonArgs = {
  key: string;
  params?: Params;
  baseUrl?: string;
};

async function getJson<T>({ key, params, baseUrl }: GetJsonArgs): Promise<T | null> {
  const cache = await getJsonCache();
  const finalKey = buildCacheKey({ key, params: params ?? {}, baseUrl });
  const response = await cache.match(finalKey);
  if (!response || !response.ok) return null;
  const data = (await response.json()) as T;
  logger.debug('Cache hit for key: ', finalKey.toString());
  return data;
}

type GetOrSetJsonArgs<T> = {
  key: string;
  fetcher: () => Promise<T> | T;
  params?: Params;
  baseUrl?: string;
  options?: {
    ttlSeconds?: number;
  };
};

async function getOrSetJson<T>({ key, fetcher, options, params, baseUrl }: GetOrSetJsonArgs<T>): Promise<T> {
  const cached = await getJson<T>({ key, params, baseUrl });
  if (cached) return cached;

  const fresh = await fetcher();
  if (fresh === null || fresh === undefined) {
    return fresh;
  }
  await putJson({ key, data: fresh, params, baseUrl, options });
  return fresh;
}

export const cache = {
  putJson,
  getJson,
  getOrSetJson,
  buildCacheKey,
};

export type { GetJsonArgs, GetOrSetJsonArgs, PutJsonArgs };
