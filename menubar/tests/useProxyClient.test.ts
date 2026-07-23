import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useProxyClient } from "../src/hooks/useProxyClient";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("useProxyClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with offline state", () => {
    mockFetch.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useProxyClient());
    expect(result.current.online).toBe(false);
    expect(result.current.usage.requests).toBe(0);
    expect(result.current.combos).toEqual([]);
    expect(result.current.quotas).toEqual([]);
  });

  it("fetches settings and marks online", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/api/settings")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ port: 10100, hostname: "127.0.0.1", codexAutoStart: true }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const { result } = renderHook(() => useProxyClient());

    await act(async () => {
      result.current.startPolling();
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.online).toBe(true);

    act(() => {
      result.current.stopPolling();
    });
  });

  it("marks offline when fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("connection refused"));

    const { result } = renderHook(() => useProxyClient());

    await act(async () => {
      result.current.startPolling();
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.online).toBe(false);

    act(() => {
      result.current.stopPolling();
    });
  });
});
