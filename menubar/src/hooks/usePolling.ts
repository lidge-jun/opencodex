import { useCallback, useEffect, useRef, useState } from "react";

export interface PollingState<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  lastUpdated: number | null;
}

export function usePolling<T>(
  fetcher: () => Promise<T | null>,
  intervalMs = 10000,
): PollingState<T> & { refresh: () => void } {
  const [state, setState] = useState<PollingState<T>>({
    data: null,
    loading: true,
    error: false,
    lastUpdated: null,
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const poll = useCallback(async () => {
    try {
      const data = await fetcherRef.current();
      setState((prev) => ({
        data: data ?? prev.data,
        loading: false,
        error: data === null,
        lastUpdated: data !== null ? Date.now() : prev.lastUpdated,
      }));
    } catch {
      setState((prev) => ({ ...prev, loading: false, error: true }));
    }
  }, []);

  useEffect(() => {
    poll();
    timerRef.current = setInterval(poll, intervalMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [poll, intervalMs]);

  return { ...state, refresh: poll };
}
