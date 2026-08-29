import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Providers from "../src/pages/Providers";

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
  // Let config fetch resolve + render
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      jest.advanceTimersByTime(0);
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

  // Button may or may not be rendered for empty config — handle both cases
  const btn = findTestAllButton(container);
  if (btn) {
    await act(async () => { btn.click(); });
    await driveAsyncBatch();
  }

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
  // The first 3 workers each pick one item.
  expect(maxInFlight).toBeLessThanOrEqual(3);
  expect(maxInFlight).toBeGreaterThanOrEqual(1);

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

  const { root, container } = await mountProviders(makeFetchHandler(calls, {
    config: cfg,
    test: () => d.promise,
  }));

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
  // If we reach here without errors, the aliveRef guard worked
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

  const { root, container } = await mountProviders(makeFetchHandler([], {
    config: cfg,
    test: (_url, _init) => {
      // The second arg has { signal } from fetch — we capture it from the mock
      return d.promise;
    },
  }));

  // Override fetch to capture signals
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/providers/test")) {
      if (init?.signal) signals.push(init.signal);
      return d.promise;
    }
    return origFetch(input, init);
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

test("12. abort does not show toast", async () => {
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" }, anthropic: { adapter: "anthropic", baseUrl: "https://b" } } };
  const d = defer<Response>();

  const { root, container } = await mountProviders(makeFetchHandler([], { config: cfg }));

  // Override fetch to use deferred
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/providers/test")) return d.promise;
    return origFetch(input);
  }) as typeof fetch;

  const btn = findTestAllButton(container)!;
  await act(async () => { btn.click(); });

  // Unmount to abort
  await act(async () => { root.unmount(); });

  // Resolve the deferred after unmount
  await act(async () => { d.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });

  // No toast should appear — page text should not contain success/failure messages
  expect(pageText()).not.toContain("healthy");
  expect(pageText()).not.toContain("with errors");
});

test("13. replacement batch: button disabled prevents concurrent batch", async () => {
  const cfg = { providers: { openai: { adapter: "openai", baseUrl: "https://a" }, anthropic: { adapter: "anthropic", baseUrl: "https://b" }, grok: { adapter: "grok", baseUrl: "https://c" } } };

  const d1 = defer<Response>();

  const calls: string[] = [];
  const { root, container } = await mountProviders(makeFetchHandler(calls, { config: cfg }));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/providers/test")) return d1.promise;
    return origFetch(input);
  }) as typeof fetch;

  const btn = findTestAllButton(container)!;

  // Start first batch
  await act(async () => { btn.click(); });
  // Button should be disabled (batchTesting = true) — shows "Testing…"
  const testingBtn1 = findTestingButton(container);
  expect(testingBtn1).not.toBeNull();
  expect(testingBtn1!.disabled).toBe(true);

  // The original "Test All" button is now showing "Testing…" and is disabled,
  // so clicking it again is a no-op (disabled). This is the correct behavior:
  // the component returns early when batchTesting is true.
  expect(testingBtn1!.disabled).toBe(true);

  // Complete first batch
  await act(async () => { d1.resolve(jsonResponse({ ok: true, latencyMs: 10 })); });
  await driveAsyncBatch();

  // After first batch completes, button should be enabled again
  const btnAfter = findTestAllButton(container);
  expect(btnAfter).not.toBeNull();
  expect(btnAfter!.disabled).toBe(false);

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

  // Let workers start
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }

  // With 4 providers and concurrency 3, first 3 should start immediately
  expect(pendingDeferreds.length).toBeGreaterThanOrEqual(3);
  expect(maxInFlight).toBeLessThanOrEqual(3);

  // Complete the first request — the 4th should immediately start
  await act(async () => { pendingDeferreds[0].resolve(jsonResponse({ ok: true, latencyMs: 5 })); });

  // Let microtasks settle so worker picks up next item
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
      jest.advanceTimersByTime(0);
    });
  }

  // All 4 should now be in flight or completed
  expect(pendingDeferreds.length).toBe(4);

  // Complete remaining
  for (let i = 1; i < 4; i++) {
    await act(async () => { pendingDeferreds[i].resolve(jsonResponse({ ok: true, latencyMs: 5 })); });
  }
  await driveAsyncBatch();

  expect(calls.length).toBe(4);
  expect(maxInFlight).toBeLessThanOrEqual(3);

  await act(async () => { root.unmount(); });
});
