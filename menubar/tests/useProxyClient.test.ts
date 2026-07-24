import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePolling } from "../src/hooks/usePolling";

describe("usePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in loading state", () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => usePolling(fetcher, 10000));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it("stores data on successful fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 42 });
    const { result } = renderHook(() => usePolling(fetcher, 10000));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBe(false);
  });

  it("sets error on null response", async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => usePolling(fetcher, 10000));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(true);
  });

  it("clears stale data after 3 consecutive failures", async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ value: "initial" });
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => usePolling(fetcher, 1000));

    // First poll succeeds
    await waitFor(() => expect(result.current.data).toEqual({ value: "initial" }));

    // Trigger 3 more polls that fail
    for (let i = 0; i < 3; i++) {
      act(() => { vi.advanceTimersByTime(1000); });
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(i + 2));
    }

    // After 3 consecutive failures, data should be cleared
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBe(true);
  });
});
