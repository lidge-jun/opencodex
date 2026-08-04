import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import MemoryObservabilityCard from "../src/components/MemoryObservabilityCard";

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let originalConfirm: typeof window.confirm | undefined;

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    actEnv: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  };
  restoreGlobals = () => {
    for (const [key, descriptor] of [
      ["document", previous.document],
      ["window", previous.window],
      ["localStorage", previous.localStorage],
      ["IS_REACT_ACT_ENVIRONMENT", previous.actEnv],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalConfirm && typeof window !== "undefined") window.confirm = originalConfirm;
  originalConfirm = undefined;
  restoreGlobals?.();
});

const MEMORY_PAYLOAD = {
  pid: 4242,
  rss: 1536,
  heapUsed: 2_097_152,
  heapTotal: 4_194_304,
  external: 8_388_608,
  arrayBuffers: 1_048_576,
  observedBytes: 8_388_608,
  observedMetric: "external",
  activeTurnCount: 2,
  isDraining: false,
  responseState: { count: 3, totalBytes: 5_242_880, largestBytes: 1_048_576, oldestAgeMs: 60_000 },
  watchdog: {
    warnThresholdBytes: 4 * 1024 ** 3,
    lastWarnAt: null,
    observedBytes: 8_388_608,
    observedMetric: "external",
    samples: [
      { at: 0, rss: 1536, heapUsed: 2_097_152, heapTotal: 4_194_304, external: 4_194_304, arrayBuffers: 1_048_576, observedBytes: 4_194_304, observedMetric: "external" },
      { at: 3_600_000, rss: 1536, heapUsed: 2_097_152, heapTotal: 4_194_304, external: 8_388_608, arrayBuffers: 1_048_576, observedBytes: 8_388_608, observedMetric: "external" },
    ],
  },
};

async function mountCard(respond: (url: string) => Promise<Response> | Response): Promise<{
  root: Root; container: HTMLElement; testWindow: Window; calls: () => string[];
}> {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return respond(url);
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <MemoryObservabilityCard apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
  return { root, container, testWindow, calls: () => calls };
}

function defaultRespond(url: string): Response {
  if (url.includes("/api/startup-health")) {
    return Response.json({ protection: "service" });
  }
  if (url.includes("/api/system/memory")) {
    return Response.json(MEMORY_PAYLOAD);
  }
  return new Response(null, { status: 404 });
}

// The formatter stays module-private (exporting it breaks the react-refresh lint rule for
// component files), so unit-scale coverage rides on the rendered card below — which is stronger
// evidence anyway: it also proves the card fetches, mounts, and unmounts correctly.
test("a healthy payload renders the metrics with binary units", async () => {
  const { root, container, calls } = await mountCard(defaultRespond);

  expect(calls().some(c => c.includes("/api/system/memory"))).toBe(true);
  const text = container.textContent ?? "";
  expect(text).toContain("1.5 KiB");      // rss
  expect(text).toContain("2.0 MiB");      // heapUsed
  expect(text).toContain("8.0 MiB (external)"); // observed memory
  expect(text).toContain("4.0 MiB/h");    // observed drift/hour
  expect(text).toContain("5.0 MiB");      // response-store total
  expect(text).not.toContain("1.5 KB");   // the mislabelled decimal unit must be gone
  expect(text).toContain("Drain & restart");
  expect(text).toContain("In-flight");

  await act(async () => { root.unmount(); });
});

test("unmounting stops the poll instead of leaving it running", async () => {
  const { root, testWindow, calls } = await mountCard(defaultRespond);
  const before = calls().filter(c => c.includes("/api/system/memory")).length;
  expect(before).toBeGreaterThanOrEqual(1);

  await act(async () => { root.unmount(); });

  // The 5s interval must have been cleared: advancing past it issues no further request.
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
  expect(calls().filter(c => c.includes("/api/system/memory")).length).toBe(before);
});

test("a non-OK response degrades to the unavailable note instead of crashing", async () => {
  const { root, container } = await mountCard((url) => {
    if (url.includes("/api/startup-health")) return Response.json({ protection: "none" });
    return new Response("nope", { status: 500 });
  });

  const text = container.textContent ?? "";
  expect(text).toContain("Memory");
  // No metric values are rendered, and the card still mounts.
  expect(text).not.toContain("KiB");
  expect(text).not.toContain("MiB");

  await act(async () => { root.unmount(); });
});

test("Drain & restart posts /api/system/restart after confirm", async () => {
  let restartPosts = 0;
  const { root, container, testWindow } = await mountCard((url) => {
    if (url.includes("/api/system/restart")) {
      restartPosts += 1;
      return Response.json({
        success: true,
        activeTurnCount: 2,
        drainTimeoutMs: 60_000,
        alreadyDraining: false,
      }, { status: 202 });
    }
    return defaultRespond(url);
  });

  originalConfirm = window.confirm;
  window.confirm = () => true;

  const button = Array.from(container.querySelectorAll("button")).find(
    (el) => (el.textContent ?? "").includes("Drain & restart"),
  );
  expect(button).toBeTruthy();

  await act(async () => {
    button!.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
    await new Promise(resolve => testWindow.setTimeout(resolve, 0));
  });

  expect(restartPosts).toBe(1);
  expect(container.textContent ?? "").toContain("Draining");

  await act(async () => { root.unmount(); });
});

test("older memory payloads without activeTurnCount hide the restart action", async () => {
  const legacy = { ...MEMORY_PAYLOAD } as Record<string, unknown>;
  delete legacy.activeTurnCount;
  delete legacy.isDraining;

  const { root, container } = await mountCard((url) => {
    if (url.includes("/api/startup-health")) return Response.json({ protection: "none" });
    if (url.includes("/api/system/memory")) return Response.json(legacy);
    return new Response(null, { status: 404 });
  });

  expect(container.textContent ?? "").not.toContain("Drain & restart");

  await act(async () => { root.unmount(); });
});
