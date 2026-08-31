import { describe, expect, test } from "bun:test";
import { fetchOllamaShowEnrichment } from "../src/providers/ollama-show";

/**
 * V10: the aggregate deadline TIMER ITSELF is the return bound.
 *
 * This executor GENUINELY IGNORES abort: it records that a signal was supplied, installs NO
 * abort listener that settles it, and never settles on its own until the test manually releases
 * the deferred. Under V8/V9 semantics (timer only aborts; finish() reachable only via
 * pump/worker settlement) this test HUNG the entire harness — the RED state. V10 GREEN: the
 * enrichment returns AT the injected deadline with `deadlineHit: true`, the returned Map is the
 * captured snapshot, and a late settlement after return can never mutate it.
 */

function jsonShowResponse(contextLength: number): string {
  return JSON.stringify({
    model_info: { "general.architecture": "testarch", "testarch.context_length": contextLength },
    capabilities: ["completion"],
  });
}

interface Deferred {
  resolve: (response: Response) => void;
  reject: (e: unknown) => void;
}

describe("ollama /api/show — aggregate deadline vs ignore-abort executor", () => {
  test("returns at the injected deadline with a pending ignore-abort worker; late settlement is isolated", async () => {
    const deferreds: Deferred[] = [];
    let sawSignal = false;
    let sawAbort = false;
    let active = 0;
    let maxActive = 0;

    // GENUINELY IGNORES abort: records the signal event but never settles on it.
    const ignoreAbortFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      expect(signal).toBeDefined(); // the outbound wrapper always supplies an AbortSignal
      sawSignal = true;
      active += 1;
      maxActive = Math.max(maxActive, active);
      signal!.addEventListener("abort", () => { sawAbort = true; });
      return new Promise<Response>((resolve, reject) => {
        deferreds.push({
          resolve: (response) => resolve(response),
          reject,
        });
      });
    }) as typeof fetch;

    const result = await fetchOllamaShowEnrichment({
      headers: { Authorization: "Bearer access-token-value-ollama-show" },
      discoveryUrl: "https://ollama.com/v1/models",
      modelIds: ["hang-a", "hang-b"],
      deadlineMs: 200, // injected aggregate deadline; far below any real timeout
      requestTimeoutMs: 60_000, // per-request timeout deliberately longer than the deadline
      provider: { baseUrl: "https://ollama.com/v1", fetch: ignoreAbortFetch },
    });

    expect(sawSignal).toBe(true);
    expect(result.deadlineHit).toBe(true); // returned AT the deadline
    expect(result.showRequests).toBe(2);
    expect(result.metadata.size).toBe(0); // nothing settled before the deadline
    expect(maxActive).toBeLessThanOrEqual(4); // outstanding detached work bounded

    // Capture the returned snapshot, then settle the still-pending deferred workers with valid
    // metadata and let the detached workers finish.
    const captured = JSON.stringify([...result.metadata.entries()]);
    for (const d of deferreds) {
      d.resolve(new Response(
        jsonShowResponse(262_144),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    }
    await new Promise(r => setTimeout(r, 20));

    // The returned Map is unchanged: late settlement mutated only the internal map.
    expect(result.metadata.size).toBe(0);
    expect(JSON.stringify([...result.metadata.entries()])).toBe(captured);
    void sawAbort;
  });

  test("control: an abort-respecting executor still completes before the deadline", async () => {
    let active = 0;
    let maxActive = 0;
    const abortRespectingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response(
            JSON.stringify({
              model_info: { "general.architecture": "arch", "arch.context_length": 131_072 },
              capabilities: ["completion"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ));
        }, 30);
        signal!.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
      });
    }) as typeof fetch;
    const result = await fetchOllamaShowEnrichment({
      headers: { Authorization: "Bearer access-token-value-ollama-show" },
      discoveryUrl: "https://ollama.com/v1/models",
      modelIds: ["ok-1", "ok-2"],
      deadlineMs: 5_000,
      requestTimeoutMs: 5_000,
      provider: { baseUrl: "https://ollama.com/v1", fetch: abortRespectingFetch },
    });
    expect(result.deadlineHit).toBe(false);
    expect(result.showRequests).toBe(2);
    void active; void maxActive;
  });
});
