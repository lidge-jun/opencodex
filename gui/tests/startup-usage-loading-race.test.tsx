import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Startup from "../src/pages/Startup";
import Usage from "../src/pages/Usage";

/**
 * Storage already has this coverage (storage-loading-race.test.tsx). Startup and Usage carry the
 * same generation-ownership guard but had no regression of their own, so either could lose it
 * silently. The shape is identical: start a replacement request, then settle the superseded one
 * afterwards and assert it neither clears loading nor installs its stale payload.
 */
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  // These pages read through the shared resource layer, whose cache is module-level. Without a
  // reset, a sibling case's payload satisfies the mount and the race under test never starts.
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  });
}

type Gate = { resolve: (body: unknown) => void };

test("an aborted Startup fetch must not clear loading while its replacement is in flight", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const gates: Gate[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    // Only the primary health call is gated; the follow-up calls resolve immediately so the
    // test observes the generation guard rather than incidental request ordering.
    if (!url.includes("/api/startup-health")) return new Response(null, { status: 404 });
    const body = await new Promise<unknown>(resolve => { gates.push({ resolve }); });
    return Response.json(body);
  }) as typeof fetch;

  const health = (recommendedCommand: string) => ({
    status: "protected",
    routingKind: "opencodex-local",
    routingInjected: true,
    localRoutingDependency: true,
    autostartEnabled: true,
    rebootSafe: true,
    protection: "service",
    serviceInstalled: true,
    serviceViable: true,
    serviceEnabled: true,
    serviceRunning: true,
    serviceStale: false,
    serviceConflict: false,
    serviceSupported: true,
    shimInstalled: true,
    shimHealthy: true,
    shimCoverage: "full",
    platform: "darwin",
    recommendedCommand,
    diagnosticStale: false,
    commands: { installService: "ocx service install", repairService: "ocx service repair", installShim: "ocx shim install", restoreNative: "ocx restore" },
  });
  const STALE = health("stale-startup-marker");
  const FRESH = health("fresh-startup-marker");

  function Harness() {
    const [apiBase, setApiBase] = useState("http://old");
    (window as unknown as { __bumpApiBase?: () => void }).__bumpApiBase = () => setApiBase("http://new");
    return (
      <LanguageProvider>
        <Startup apiBase={apiBase} />
      </LanguageProvider>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  await settle();
  await waitFor(() => gates.length === 1);

  await act(async () => {
    (window as unknown as { __bumpApiBase: () => void }).__bumpApiBase();
  });
  await settle();
  await waitFor(() => gates.length === 2);

  // The superseded request answers only now, after its replacement already started.
  await act(async () => {
    gates[0]!.resolve(STALE);
    await Promise.resolve();
  });
  await settle();

  expect(container.textContent).toContain("Checking startup protection");
  const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>("button.btn"))
    .find(button => (button.textContent ?? "").includes("Refresh"));
  expect(refresh).toBeTruthy();
  expect(refresh!.disabled).toBe(true);

  await act(async () => {
    gates[1]!.resolve(FRESH);
    await Promise.resolve();
  });
  await waitFor(() => !(container.textContent ?? "").includes("Checking startup protection"));
  expect(refresh!.disabled).toBe(false);

  await act(async () => { root.unmount(); });
  container.remove();
});

test("an aborted Usage fetch must not clear loading while its replacement is in flight", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const gates: Gate[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("/api/usage")) return new Response(null, { status: 404 });
    const body = await new Promise<unknown>(resolve => { gates.push({ resolve }); });
    return Response.json(body);
  }) as typeof fetch;

  const summary = {
    requests: 0, measuredRequests: 0, reportedRequests: 0, unreportedRequests: 0,
    unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 0, outputTokens: 0,
    cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, coverageRatio: 1,
  };
  const usage = (generatedAt: number) => ({
    range: "7d", surface: "all", since: null, generatedAt,
    summary, days: [], models: [], providers: [],
  });
  const STALE = usage(1);
  const FRESH = usage(2);

  function Harness() {
    const [apiBase, setApiBase] = useState("http://old");
    (window as unknown as { __bumpApiBase?: () => void }).__bumpApiBase = () => setApiBase("http://new");
    return (
      <LanguageProvider>
        <Usage apiBase={apiBase} />
      </LanguageProvider>
    );
  }

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness />);
  });
  await settle();
  await waitFor(() => gates.length === 1);

  await act(async () => {
    (window as unknown as { __bumpApiBase: () => void }).__bumpApiBase();
  });
  await settle();
  await waitFor(() => gates.length === 2);

  await act(async () => {
    gates[0]!.resolve(STALE);
    await Promise.resolve();
  });
  await settle();

  // Unconditional clearing would drop this while request #2 is still outstanding.
  expect(container.textContent).toContain("Loading usage data");

  await act(async () => {
    gates[1]!.resolve(FRESH);
    await Promise.resolve();
  });
  await waitFor(() => !(container.textContent ?? "").includes("Loading usage data"));

  await act(async () => { root.unmount(); });
  container.remove();
});
