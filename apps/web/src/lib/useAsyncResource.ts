import { useCallback, useEffect, useRef, useState } from 'react';

type AsyncState<T> = { data: T | null; loading: boolean; error: string | null; refresh: () => void };

function useAsyncResource<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const depsKey = JSON.stringify(deps);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((v) => {
        if (!cancelled) {
          setData(v);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, depsKey]);

  return { data, loading, error, refresh };
}

export { useAsyncResource };
export type { AsyncState };
