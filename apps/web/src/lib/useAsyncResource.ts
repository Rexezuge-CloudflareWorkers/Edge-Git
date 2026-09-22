import { useCallback, useEffect, useRef, useState } from 'react';

type AsyncState<T> = { data: T | null; loading: boolean; error: string | null; refresh: () => void };

function useAsyncResource<T>(loader: () => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);

  useEffect(() => {
    loaderRef.current = loader;
  });

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    setData(null);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = loaderRef.current;
    run()
      .then((v) => {
        if (cancelled) return;
        setData(v);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { data, loading, error, refresh };
}

export { useAsyncResource };
export type { AsyncState };
