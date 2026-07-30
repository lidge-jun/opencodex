import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Storage from "../src/pages/Storage";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const REPORT_A = {
  codexHome: "/tmp/a",
  generatedAt: 1,
  total: { bytes: 10, fileCount: 1 },
  buckets: [{ key: "other", label: "Other", bytes: 10, fileCount: 1 }],
};

const REPORT_B = {
  codexHome: "/tmp/b",
  generatedAt: 2,
  total: { bytes: 20, fileCount: 2 },
  buckets: [{ key: "other", label: "Other", bytes: 20, fileCount: 2 }],
};

const DEFAULT_POLICY = {
  enabled: false,
  trigger: { archivedBytesOver: 5 * 1024 ** 3 },
  target: { removeOldestPercent: 25 },
  schedule: "manual",
  mode: "quarantine",
};

/** Side-panel APIs resolve immediately so race tests only gate the storage report. */
function storageSideResponse(url: string): Response | null {
  if (url.includes("/api/storage/cleanup-policy")) return Response.json(DEFAULT_POLICY);
  if (url.includes("/api/storage/trash")) return Response.json({ entries: [] });
  if (url.includes("/api/storage/cleanup")) return Response.json({ ok: true });
  return null;
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow.sessionStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

test("an aborted Storage fetch must not clear loading while its replacement is in flight", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  type Gate = { resolve: (body: unknown) => void };
  const gates: Gate[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const side = storageSideResponse(url);
    if (side) return side;
    if (!url.includes("/api/storage")) return new Response(null, { status: 404 });
    const body = await new Promise<unknown>(resolve => {
      gates.push({ resolve });
    });
    return Response.json(body);
  }) as typeof fetch;

  function Harness() {
    const [apiBase, setApiBase] = useState("http://old");
    (window as unknown as { __bumpApiBase?: () => void }).__bumpApiBase = () => setApiBase("http://new");
    return (
      <LanguageProvider>
        <Storage apiBase={apiBase} />
      </LanguageProvider>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  });
  await waitFor(() => gates.length === 1);

  // Replacement starts; the first request is aborted by effect cleanup.
  await act(async () => {
    (window as unknown as { __bumpApiBase: () => void }).__bumpApiBase();
  });
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  });
  await waitFor(() => gates.length === 2);

  // Stale aborted request completes after the replacement has already begun.
  await act(async () => {
    gates[0]!.resolve(REPORT_A);
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  });

  const refresh = container.querySelector<HTMLButtonElement>("button.btn");
  expect(container.textContent).toContain("Scanning storage");
  expect(refresh?.disabled).toBe(true);
  expect(container.textContent).not.toContain("/tmp/a");

  await act(async () => {
    gates[1]!.resolve(REPORT_B);
    await Promise.resolve();
  });
  await waitFor(() => (container.textContent ?? "").includes("/tmp/b"));
  expect(container.textContent).not.toContain("/tmp/a");
  expect(refresh?.disabled).toBe(false);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("effect cleanup invalidates generation before abort so loading stays owned across the deferred replacement gap", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  // Hold Storage's delay-0 deferred fetches so Windows/act timer flushing cannot
  // collapse the cleanup→replacement gap this test is asserting.
  type DeferredTimer = { id: number; run: () => void };
  const deferredZero: DeferredTimer[] = [];
  let nextTimerId = 1_000_000;
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 0 && typeof handler === "function") {
      const id = nextTimerId++;
      deferredZero.push({
        id,
        run: () => { (handler as (...a: unknown[]) => void)(...args); },
      });
      return id as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(handler as never, delay as never, ...(args as never[]));
  }) as typeof setTimeout;
  window.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    const idx = deferredZero.findIndex(entry => entry.id === id);
    if (idx >= 0) {
      deferredZero.splice(idx, 1);
      return;
    }
    return realClearTimeout(id as never);
  }) as typeof clearTimeout;

  type Gate = {
    resolve: (body: unknown) => void;
    reject: (reason?: unknown) => void;
  };
  const gates: Gate[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const side = storageSideResponse(url);
    if (side) return side;
    if (!url.includes("/api/storage")) return new Response(null, { status: 404 });
    const signal = init?.signal;
    const body = await new Promise<unknown>((resolve, reject) => {
      const gate: Gate = { resolve, reject };
      gates.push(gate);
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    });
    return Response.json(body);
  }) as typeof fetch;

  function Harness() {
    const [apiBase, setApiBase] = useState("http://old");
    (window as unknown as { __bumpApiBase?: () => void }).__bumpApiBase = () => setApiBase("http://new");
    return (
      <LanguageProvider>
        <Storage apiBase={apiBase} />
      </LanguageProvider>
    );
  }

  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness />);
    });
    // Report schedules a delay-0 load; cleanup-policy mounts only after a report paints.
    expect(deferredZero.length).toBe(1);
    await act(async () => {
      while (deferredZero.length > 0) deferredZero.shift()!.run();
    });
    await waitFor(() => gates.length === 1);

    // Cleanup aborts + invalidates generation; replacement stays queued until we flush it.
    await act(async () => {
      (window as unknown as { __bumpApiBase: () => void }).__bumpApiBase();
    });
    expect(deferredZero.length).toBe(1);

    // Flush abort rejection / finally microtasks without running the deferred fetch.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const refresh = container.querySelector<HTMLButtonElement>("button.btn");
    expect(gates.length).toBe(1);
    expect(container.textContent).toContain("Scanning storage");
    expect(refresh?.disabled).toBe(true);

    await act(async () => {
      while (deferredZero.length > 0) deferredZero.shift()!.run();
    });
    await waitFor(() => gates.length === 2);

    await act(async () => {
      gates[1]!.resolve(REPORT_B);
      await Promise.resolve();
    });
    await waitFor(() => (container.textContent ?? "").includes("/tmp/b"));
    expect(refresh?.disabled).toBe(false);
  } finally {
    window.setTimeout = realSetTimeout as typeof setTimeout;
    window.clearTimeout = realClearTimeout as typeof clearTimeout;
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});
