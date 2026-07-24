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
  const consecutiveErrorsRef = useRef(0);

  const poll = useCallback(async () => {
    try {
      const data = await fetcherRef.current();
      if (data !== null) {
        consecutiveErrorsRef.current = 0;
        setState({
          data,
          loading: false,
          error: false,
          lastUpdated: Date.now(),
        });
      } else {
        consecutiveErrorsRef.current += 1;
        setState((prev) => ({
          // Clear stale data after 3 consecutive failures
          data: consecutiveErrorsRef.current >= 3 ? null : prev.data,
          loading: false,
          error: true,
          lastUpdated: prev.lastUpdated,
        }));
      }
    } catch {
      consecutiveErrorsRef.current += 1;
      setState((prev) => ({
        data: consecutiveErrorsRef.current >= 3 ? null : prev.data,
        loading: false,
        error: true,
        lastUpdated: prev.lastUpdated,
      }));
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
