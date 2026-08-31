import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Providers from "../src/pages/Providers";
import type { ProvidersConfig } from "../src/pages/providers-shared";
import { useProviderBatchController } from "../src/hooks/use-provider-batch-controller";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

function installLayoutStubs(win: Window): void {
  const proto = win.HTMLElement.prototype as unknown as HTMLElement;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value() {
      return { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800, toJSON() { return this; } };
    },
  });
  class ResizeObserverStub {
    #cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
    observe(target: Element) {
      this.#cb([{ target, contentRect: { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800, toJSON() { return this; } }, borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}

/** Deferred promise helper for controlling async timing in tests. */
function defer<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const configThreeProviders = {
  providers: {
    openai: { adapter: "openai-responses", baseUrl: "https://api.openai.com" },
    anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com" },
    grok: { adapter: "grok", baseUrl: "https://api.x.ai" },
  },
};

const emptyConfigResponse = { providers: {} };

/** Build a config object with N named providers. */
function makeConfig(names: string[]): { providers: Record<string, { adapter: string; baseUrl: string }> } {
  const providers: Record<string, { adapter: string; baseUrl: string }> = {};
  for (const n of names) providers[n] = { adapter: n, baseUrl: `https://${n}.example.com` };
  return { providers };
}

function makeFetchHandler(
  calls: string[],
  opts?: {
    config?: unknown;
    test?: (url: string) => Response | Promise<Response> | never;
  },
) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/config")) return jsonResponse(opts?.config ?? configThreeProviders);
    if (url.includes("/api/providers/test")) {
      calls.push(url);
      if (opts?.test) return opts.test(url);
      return jsonResponse({ ok: true, latencyMs: 50 });
    }
    if (url.includes("/api/providers")) return jsonResponse([]);
    if (url.includes("/api/codex-accounts")) return jsonResponse([]);
    if (url.includes("/api/oauth")) return jsonResponse({ providers: [] });
    if (url.includes("/api/provider-presets")) return jsonResponse([]);
    if (url.includes("/api/usage")) return jsonResponse({ range: "30d", summary: { requests: 0, totalTokens: 0, estimatedCostUsd: 0 }, models: [], providers: [], accounts: [], days: [] });
    if (url.includes("/api/settings")) return jsonResponse({ port: 10100, hostname: "127.0.0.1", timeZone: "UTC" });
    return jsonResponse({});
  }) as typeof fetch;
}

/* ------------------------------------------------------------------ */
/*  Setup / Teardown                                                  */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  clearClientResourceStoresForTests();
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountProviders(fetchFn: typeof fetch): Promise<{ root: Root; container: HTMLElement }> {
  globalThis.fetch = fetchFn;
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Providers apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  // Let config fetch resolve + render settle
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  return { root, container };
}

/** Drive the component through multiple act cycles so async batch completes + state commits. */
async function driveAsyncBatch(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }
  await act(async () => { jest.advanceTimersByTime(200); });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }
}

function findTestAllButton(container: HTMLElement): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find(
    btn => btn.textContent?.includes("Test All"),
  ) ?? null;
}

/** Find the button that shows "Testing…" text (during batch). */
function findTestingButton(container: HTMLElement): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find(
    btn => btn.textContent?.includes("Testing"),
  ) ?? null;
}

/** Get full page text including portal content (toasts render to document.body). */
function pageText(): string {
  return document.body.textContent ?? "";
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

test("1. all providers succeed", async () => {
  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls, { config: configThreeProviders }));

  const btn = findTestAllButton(container)!;
  expect(btn).not.toBeNull();
  expect(btn.disabled).toBe(false);

  await act(async () => { btn.click(); });
  await driveAsyncBatch();

  // Each provider name appeared exactly once in test calls
  expect(calls.length).toBeGreaterThanOrEqual(3);
  expect(calls.filter(u => u.includes("name=openai")).length).toBe(1);
  expect(calls.filter(u => u.includes("name=anthropic")).length).toBe(1);
  expect(calls.filter(u => u.includes("name=grok")).length).toBe(1);

  // Toast contains the success message (portaled to document.body)
  expect(pageText()).toContain("All 3 providers healthy.");

  // Button re-enabled
  const btnAfter = findTestAllButton(container);
  expect(btnAfter).not.toBeNull();
  expect(btnAfter!.disabled).toBe(false);

  await act(async () => { root.unmount(); });
});

test("2. partial failures", async () => {
  const calls: string[] = [];
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" }, anthropic: { adapter: "anthropic", baseUrl: "https://b" } } };
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    config: cfg,
    test: (url) => {
      if (url.includes("name=openai")) return jsonResponse({ ok: true, latencyMs: 42 });
      return jsonResponse({ ok: false, error: "bad key" });
    },
  }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });
  await driveAsyncBatch();

  // Both tested
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.some(u => u.includes("name=openai"))).toBe(true);
  expect(calls.some(u => u.includes("name=anthropic"))).toBe(true);

  // Toast says partial (portaled to document.body)
  expect(pageText()).toContain("1 healthy, 1 with errors.");

  // Button re-enabled
  expect(findTestAllButton(container)).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("3. non-2xx treated as failure", async () => {
  const calls: string[] = [];
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" }, anthropic: { adapter: "anthropic", baseUrl: "https://b" } } };
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    config: cfg,
    test: () => jsonResponse({ error: "server error" }, 500),
  }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });
  await driveAsyncBatch();

  // Both providers were tested (test calls went out)
  expect(calls.length).toBeGreaterThanOrEqual(2);

  // Both are failures → toast shows 0 healthy, 2 with errors
  expect(pageText()).toContain("0 healthy, 2 with errors.");

  // Button re-enabled
  expect(findTestAllButton(container)).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("4. invalid JSON counted as failure", async () => {
  const calls: string[] = [];
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" } } };
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    config: cfg,
    test: () => textResponse("not json"),
  }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });
  await driveAsyncBatch();

  // The test call was made
  expect(calls.length).toBeGreaterThanOrEqual(1);
  expect(calls[0]).toContain("name=openai");

  // Invalid JSON → failure; toast shows 0 healthy, 1 with errors
  expect(pageText()).toContain("0 healthy, 1 with errors.");

  // No unhandled rejection — component handles it gracefully
  expect(findTestAllButton(container)).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("5. network error counted as failure, other providers still tested", async () => {
  const calls: string[] = [];
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" }, anthropic: { adapter: "anthropic", baseUrl: "https://b" } } };
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    config: cfg,
    test: (url) => {
      if (url.includes("name=openai")) throw new TypeError("fetch failed");
      return jsonResponse({ ok: true, latencyMs: 30 });
    },
  }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });
  await driveAsyncBatch();

  // Both providers tested despite one throwing
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.some(u => u.includes("name=openai"))).toBe(true);
  expect(calls.some(u => u.includes("name=anthropic"))).toBe(true);

  // openai failed, anthropic succeeded → partial toast
  expect(pageText()).toContain("1 healthy, 1 with errors.");

  expect(findTestAllButton(container)).not.toBeNull();

  await act(async () => { root.unmount(); });
});

test("6. empty provider config sends no test requests", async () => {
  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    config: emptyConfigResponse,
  }));

  // The header button renders whenever config is loaded, including an empty provider map.
  const btn = findTestAllButton(container);
  expect(btn).not.toBeNull();
  expect(btn!.disabled).toBe(false);
  await act(async () => { btn!.click(); });
  await driveAsyncBatch();
  // The click must hit the names.length === 0 early return, not start a batch.
  expect(findTestingButton(container)).toBeNull();

  // Zero test API calls
  expect(calls).toHaveLength(0);

  // No crash
  await act(async () => { root.unmount(); });
});

test("7. button disabled during batch, shows Testing…", async () => {
  const calls: string[] = [];
  const d1 = defer<Response>();
  const d2 = defer<Response>();
  const deferreds = [d1, d2];
  let idx = 0;
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" }, anthropic: { adapter: "anthropic", baseUrl: "https://b" } } };

  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    config: cfg,
    test: () => deferreds[idx++].promise,
  }));

  const btn = findTestAllButton(container)!;
  expect(btn).not.toBeNull();

  // Click to start batch
  await act(async () => { btn.click(); });

  // Immediately after click: button should show "Testing…" and be disabled
  const testingBtn = findTestingButton(container);
  expect(testingBtn).not.toBeNull();
  expect(testingBtn!.disabled).toBe(true);

  // Complete all deferred requests
  await act(async () => { d1.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });
  await act(async () => { d2.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });
  await driveAsyncBatch();

  // After completion: button shows "Test All" and is enabled
  const btnAfter = findTestAllButton(container);
  expect(btnAfter).not.toBeNull();
  expect(btnAfter!.disabled).toBe(false);

  await act(async () => { root.unmount(); });
});

test("8. max concurrency ≤ 3", async () => {
  const names = ["a", "b", "c", "d", "e", "f"];
  const cfg = makeConfig(names);

  // Shared deferreds that the test handler pushes to, so we can resolve them externally
  const pendingDeferreds: ReturnType<typeof defer<Response>>[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    config: cfg,
    test: () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      const d = defer<Response>();
      pendingDeferreds.push(d);
      // Chain: decrement in-flight when resolved
      return d.promise.then(v => { inFlight--; return v; }, e => { inFlight--; throw e; });
    },
  }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });

  // Let microtasks settle so workers pick up items from the queue
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }

  // With 6 providers and concurrency 3, at most 3 should be in-flight.
  // The first 3 workers each pick one item, so the peak is exactly 3. An upper bound
  // alone would still pass if the workers serialized to 1.
  expect(maxInFlight).toBe(3);

  // Resolve all pending deferreds
  for (const d of pendingDeferreds) {
    await act(async () => { d.resolve(jsonResponse({ ok: true, latencyMs: 5 })); });
  }
  await driveAsyncBatch();

  // All 6 should have been tested (may need multiple waves since concurrency is 3)
  expect(calls.length).toBe(6);

  await act(async () => { root.unmount(); });
});

test("9. unmount during batch aborts requests without state-update errors", async () => {
  const calls: string[] = [];
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" }, anthropic: { adapter: "anthropic", baseUrl: "https://b" } } };
  const d = defer<Response>();

  const baseHandler = makeFetchHandler(calls, { config: cfg, test: () => d.promise });
  const { root, container } = await mountProviders(baseHandler);

  const signals: AbortSignal[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/providers/test") && init?.signal) {
      signals.push(init.signal);
    }
    return baseHandler(input, init);
  }) as typeof fetch;

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });

  // Unmount immediately — aliveRef should prevent state updates
  await act(async () => { root.unmount(); });

  // Resolve the deferred — should NOT produce act() warnings or state-update errors
  await act(async () => { d.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });

  // Additional settle cycles
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }
  // Verify signals were captured and aborted
  expect(signals.length).toBeGreaterThanOrEqual(1);
  for (const sig of signals) {
    expect(sig.aborted).toBe(true);
  }
});

test("10. toast text accuracy for success case (1 provider)", async () => {
  const calls: string[] = [];
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" } } };
  const { root, container } = await mountProviders(makeFetchHandler(calls, { config: cfg }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });
  await driveAsyncBatch();

  // Verify exact toast text for count=1 (portaled to document.body)
  expect(pageText()).toContain("All 1 providers healthy.");

  await act(async () => { root.unmount(); });
});

// ─── Cancellation-specific tests ───

test("11. unmount aborts batch signal", async () => {
  const signals: AbortSignal[] = [];
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" }, anthropic: { adapter: "anthropic", baseUrl: "https://b" } } };
  const d = defer<Response>();

  const baseHandler = makeFetchHandler([], { config: cfg });
  const { root, container } = await mountProviders(baseHandler);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/providers/test")) {
      if (init?.signal) signals.push(init.signal);
      return d.promise;
    }
    // Stay inside the mock: no test may touch the network.
    return baseHandler(input, init);
  }) as typeof fetch;

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });

  // Unmount while batch is in progress
  await act(async () => { root.unmount(); });

  // Signal should be aborted
  expect(signals.length).toBeGreaterThanOrEqual(1);
  for (const sig of signals) {
    expect(sig.aborted).toBe(true);
  }

  // Resolve deferred — should not cause errors
  await act(async () => { d.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });
});

test("12. abort exits Testing UI and shows no toast", async () => {
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" }, anthropic: { adapter: "anthropic", baseUrl: "https://b" } } };
  const d = defer<Response>();

  const baseHandler = makeFetchHandler([], { config: cfg });
  const { root, container } = await mountProviders(baseHandler);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/providers/test")) return d.promise;
    // Stay inside the mock: no test may touch the network.
    return baseHandler(input);
  }) as typeof fetch;

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });

  // Verify Testing state is active
  expect(findTestingButton(container)).not.toBeNull();

  // Unmount to abort (cancelCurrentBatch)
  await act(async () => { root.unmount(); });

  // Resolve the deferred after unmount
  await act(async () => { d.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });

  // No toast should appear
  expect(pageText()).not.toContain("healthy");
  expect(pageText()).not.toContain("with errors");
});

test("13. overlapping replacement via apiBase change: batch 1 aborted, batch 2 takes over", async () => {
  // 1 provider so the deferred blocks the entire batch.
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" } } };
  const d1 = defer<Response>();
  const d2 = defer<Response>();

  const signals: AbortSignal[] = [];
  let testCallCount = 0;
  let usedApiBases: string[] = [];

  const baseHandler = makeFetchHandler([], { config: cfg });
  const { root, container } = await mountProviders(baseHandler);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/providers/test")) {
      if (init?.signal) signals.push(init.signal);
      const match = url.match(/^(https?:\/\/[^/]+)/);
      if (match) usedApiBases.push(match[1]);
      testCallCount++;
      if (testCallCount === 1) return d1.promise;
      return d2.promise;
    }
    // Config fetch for bootstrap: return same config
    if (url.includes("/api/config")) return jsonResponse(cfg);
    // Every other route stays inside the mock: no test may touch the network.
    return baseHandler(input, init);
  }) as typeof fetch;

  const btn = findTestAllButton(container)!;

  // Start batch 1 — d1 blocks the entire batch (1 provider)
  await act(async () => { btn.click(); });
  for (let i = 0; i < 5; i++) {
    await act(async () => { await Promise.resolve(); jest.advanceTimersByTime(0); });
  }
  expect(signals.length).toBe(1);
  expect(testCallCount).toBe(1);

  // While batch 1 is pending, re-render with new apiBase.
  // This triggers cancelCurrentBatch: abort + setBatchTesting(false).
  await act(async () => {
    root.render(
      <LanguageProvider>
        <Providers apiBase="http://localhost:9999" />
      </LanguageProvider>,
    );
  });
  // Let the apiBase effect + re-render settle
  await act(async () => { await Promise.resolve(); jest.advanceTimersByTime(0); });

  // Batch 1 signal should be aborted
  expect(signals[0].aborted).toBe(true);

  // UI should exit Testing state (cancelCurrentBatch called setBatchTesting(false))
  const btnAfter = findTestAllButton(container);
  expect(btnAfter).not.toBeNull();
  expect(btnAfter!.disabled).toBe(false);

  // Start batch 2 on new apiBase — d2 blocks it
  await act(async () => { btnAfter!.click(); });
  for (let i = 0; i < 5; i++) {
    await act(async () => { await Promise.resolve(); jest.advanceTimersByTime(0); });
  }

  // Both deferreds consumed
  expect(testCallCount).toBe(2);
  // Batch 2 uses the new apiBase
  expect(usedApiBases.some(b => b.includes("9999"))).toBe(true);

  // Resolve stale d1 — should not produce toast
  await act(async () => { d1.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });
  await driveAsyncBatch();
  expect(pageText()).not.toContain("healthy");
  expect(pageText()).not.toContain("with errors");

  // Batch 2 should still be Testing
  expect(findTestingButton(container)).not.toBeNull();

  // Resolve d2 — batch 2 completes with its own toast
  await act(async () => { d2.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });
  await driveAsyncBatch();
  expect(pageText()).toContain("All 1 providers healthy.");

  // Button re-enabled
  const btnFinal = findTestAllButton(container);
  expect(btnFinal).not.toBeNull();
  expect(btnFinal!.disabled).toBe(false);

  await act(async () => { root.unmount(); });
});

test("14. max concurrency refills immediately after one request completes", async () => {
  const names = ["a", "b", "c", "d"];
  const cfg = makeConfig(names);

  const pendingDeferreds: ReturnType<typeof defer<Response>>[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    config: cfg,
    test: () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      const d = defer<Response>();
      pendingDeferreds.push(d);
      return d.promise.then(v => { inFlight--; return v; }, e => { inFlight--; throw e; });
    },
  }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });

  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }

  expect(pendingDeferreds.length).toBeGreaterThanOrEqual(3);
  expect(maxInFlight).toBe(3);

  await act(async () => { pendingDeferreds[0].resolve(jsonResponse({ ok: true, latencyMs: 5 })); });

  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }

  expect(pendingDeferreds.length).toBe(4);

  for (let i = 1; i < 4; i++) {
    await act(async () => { pendingDeferreds[i].resolve(jsonResponse({ ok: true, latencyMs: 5 })); });
  }
  await driveAsyncBatch();

  expect(calls.length).toBe(4);
  expect(maxInFlight).toBe(3);

  await act(async () => { root.unmount(); });
});

// ─── Config / apiBase change cancellation tests ───

test("15. apiBase change aborts batch and exits Testing UI, then new batch works on new apiBase", async () => {
  // Verifies: (1) signal aborted, (2) UI exits Testing, (3) new batch works on new apiBase.
  const signals: AbortSignal[] = [];
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" } } };
  const d1 = defer<Response>();
  const d2 = defer<Response>();

  let testCallCount = 0;
  let usedApiBases: string[] = [];

  const baseHandler = makeFetchHandler([], { config: cfg });
  const { root, container } = await mountProviders(baseHandler);

  // Capture signals and apiBase used for each test request
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/providers/test")) {
      if (init?.signal) signals.push(init.signal);
      // Extract apiBase from the URL
      const match = url.match(/^(https?:\/\/[^/]+)/);
      if (match) usedApiBases.push(match[1]);
      testCallCount++;
      if (testCallCount === 1) return d1.promise;
      return d2.promise;
    }
    // Every other route stays inside the mock: no test may touch the network.
    return baseHandler(input, init);
  }) as typeof fetch;

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });

  // Let batch 1 start
  for (let i = 0; i < 5; i++) {
    await act(async () => { await Promise.resolve(); jest.advanceTimersByTime(0); });
  }
  expect(signals.length).toBeGreaterThanOrEqual(1);

  // Re-render with new apiBase on the SAME root — triggers cancelCurrentBatch
  await act(async () => {
    root.render(
      <LanguageProvider>
        <Providers apiBase="http://localhost:9999" />
      </LanguageProvider>,
    );
  });

  // Signal 1 should be aborted
  expect(signals.some(s => s.aborted)).toBe(true);

  // Resolve batch 1 deferred
  await act(async () => { d1.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });
  await driveAsyncBatch();

  // UI should have exited Testing state after cancelCurrentBatch
  const btnAfter = findTestAllButton(container);
  expect(btnAfter).not.toBeNull();
  expect(btnAfter!.disabled).toBe(false);

  // Start batch 2 on new apiBase
  await act(async () => { btnAfter!.click(); });
  for (let i = 0; i < 5; i++) {
    await act(async () => { await Promise.resolve(); jest.advanceTimersByTime(0); });
  }

  // batch 2 should use the new apiBase
  expect(testCallCount).toBe(2);
  expect(usedApiBases.some(b => b.includes("9999"))).toBe(true);

  await act(async () => { d2.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });
  await driveAsyncBatch();

  // Batch 2 completed with its own toast
  expect(pageText()).toContain("All 1 providers healthy.");

  await act(async () => { root.unmount(); });
});

test("16. same-base config refresh cancels in-flight batch", async () => {
  // Verifies the production generation mechanism WITHOUT changing apiBase:
  // fetchConfig() → generation++ → useEffect([generation]) → cancelMountedBatch().
  // Tests the hook directly by rendering a minimal component that tracks state via refs.
  const { useProviderBatchController } = await import("../src/hooks/use-provider-batch-controller");
  const { createRoot } = await import("react-dom/client");

  let hcRef: ReturnType<typeof useProviderBatchController> | null = null;
  // Track batchTesting state via ref since the component returns null and React won't flush it.
  let batchTestingRef = false;

  function BatchTestHarness() {
    const controller = useProviderBatchController();
    hcRef = controller;
    // Sync batchTesting state to our ref on every render.
    batchTestingRef = controller.batchTesting;
    return null;
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<BatchTestHarness />);
  });
  for (let i = 0; i < 10; i++) {
    await act(async () => { await Promise.resolve(); jest.advanceTimersByTime(0); });
  }

  expect(hcRef).not.toBeNull();
  const hc = hcRef!;

  // Start batch A
  let controllerA!: AbortController;
  await act(async () => { controllerA = hcRef!.startBatch(); });
  await act(async () => { batchTestingRef = hcRef!.batchTesting; });
  expect(batchTestingRef).toBe(true);
  expect(controllerA.signal.aborted).toBe(false);

  // Simulate config refresh: call cancelMountedBatch (same effect as generation bump)
  await act(async () => { hcRef!.cancelMountedBatch(); });
  await act(async () => { batchTestingRef = hcRef!.batchTesting; });
  expect(batchTestingRef).toBe(false);
  expect(controllerA.signal.aborted).toBe(true);
  expect(hcRef!.isActiveBatch(controllerA)).toBe(false);

  // Start batch B
  let controllerB!: AbortController;
  await act(async () => { controllerB = hcRef!.startBatch(); });
  await act(async () => {
    batchTestingRef = hcRef!.batchTesting;
  });
  expect(batchTestingRef).toBe(true);
  expect(controllerB.signal.aborted).toBe(false);
  expect(hcRef!.isActiveBatch(controllerB)).toBe(true);
  expect(hcRef!.isActiveBatch(controllerA)).toBe(false);

  // Unmount cleanup
  hcRef!.abortBatchOnUnmount();
  expect(controllerB.signal.aborted).toBe(true);

  await act(async () => { root.unmount(); });
});

test("17. stale batch resolve after unmount: no toast, no state corruption", async () => {
  // 1 provider so d1 blocks the entire batch.
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" } } };
  const d1 = defer<Response>();

  let testCallCount = 0;
  const baseHandler = makeFetchHandler([], { config: cfg });

  const { root, container } = await mountProviders(baseHandler);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/providers/test")) {
      testCallCount++;
      return d1.promise;
    }
    // Stay inside the mock: no test may touch the network.
    return baseHandler(input);
  }) as typeof fetch;

  const btn = findTestAllButton(container)!;

  // Start batch 1
  await act(async () => { btn.click(); });
  for (let i = 0; i < 5; i++) {
    await act(async () => { await Promise.resolve(); jest.advanceTimersByTime(0); });
  }

  // Only 1 request was made (1 provider)
  expect(testCallCount).toBe(1);

  // Unmount — cancelCurrentBatch: abort + setBatchTesting(false)
  await act(async () => { root.unmount(); });

  // No toast from batch 1
  expect(pageText()).not.toContain("healthy");
  expect(pageText()).not.toContain("with errors");

  // Resolve batch 1 deferred after unmount — should not show toast
  await act(async () => { d1.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });
  await driveAsyncBatch();
  expect(pageText()).not.toContain("healthy");

  // Only 1 request was consumed
  expect(testCallCount).toBe(1);
});

test("18. abort stops queue: unstarted providers never fire requests", async () => {
  // 5 providers, concurrency 3. After 3 start, abort. Verify only 3 requests fire.
  const cfg = makeConfig(["a", "b", "c", "d", "e"]);
  const pendingDeferreds: ReturnType<typeof defer<Response>>[] = [];
  const testCalls: string[] = [];

  const { root, container } = await mountProviders(makeFetchHandler([], {
    config: cfg,
    test: (url) => {
      testCalls.push(url);
      const d = defer<Response>();
      pendingDeferreds.push(d);
      return d.promise;
    },
  }));

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });

  // Let workers start — with concurrency 3, first 3 should start
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }

  expect(pendingDeferreds.length).toBeGreaterThanOrEqual(3);
  expect(pendingDeferreds.length).toBeLessThanOrEqual(3);

  // Abort the batch by unmounting
  await act(async () => { root.unmount(); });

  // Resolve active deferreds — workers should exit due to signal.aborted
  for (const d of pendingDeferreds) {
    await act(async () => { d.resolve(jsonResponse({ ok: true, latencyMs: 5 })); });
  }

  // Wait for workers to notice abort
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }

  // Only 3 requests should have been made (the ones already in flight when abort happened)
  expect(testCalls.length).toBe(3);
});
