import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "HTMLElement",
  "IS_REACT_ACT_ENVIRONMENT",
  "__APP_VERSION__",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let host: HTMLDivElement;

function json(value: unknown): Response {
  return Response.json(value);
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#guardrails" });
  Object.defineProperty(testWindow.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    HTMLElement: { configurable: true, value: testWindow.HTMLElement },
    __APP_VERSION__: { configurable: true, value: "2.37.0-test" },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
    if (url.pathname === "/healthz") {
      return json({ status: "ok", version: "2.37.0-test", uptime: 1 });
    }
    if (url.pathname === "/api/guardrails/rules") {
      return json({
        revision: "rev-1",
        rules: [],
        builtinRuleCount: 0,
        customRuleCount: 0,
        customRules: [],
      });
    }
    if (url.pathname === "/api/guardrails/activity") {
      return json({
        counters: {
          scanned: 0,
          masked: 0,
          detected: 0,
          blocked: 0,
          passthrough: 0,
          demaskWarning: 0,
          toolArgumentRestoreSkipped: 0,
        },
        topRules: [],
        topCategories: [],
        recentEvents: [],
        events: [],
        totalMatching: 0,
        filteredSummary: {
          eventCount: 0,
          findingCount: 0,
          averageLatencyMs: 0,
          topRules: [],
          topCategories: [],
        },
        lastPassthroughAt: null,
        retention: {
          kind: "in-memory",
          ttlMs: 3_600_000,
          maxEvents: 1_000,
          maxBytes: 2_097_152,
          currentEvents: 0,
          currentBytes: 0,
          evictedEvents: 0,
          oldestAt: null,
          lastEventAt: null,
        },
      });
    }
    if (url.pathname === "/api/guardrails") {
      return json({
        activation: { status: "active" },
        configuredEnabled: true,
        customRuleCount: 0,
        disabledBuiltinRuleIds: [],
        enabled: true,
        enabledDataTypes: [1, 2, 3, 4, 5, 6],
        failurePolicy: "block",
        keywordPrefilterEnabled: false,
        mode: "enforce",
        providerOptions: [],
        providerScope: { mode: "all" },
        registry: {
          status: "ready",
          generation: 1,
          policyRevision: "policy-1",
          effectiveRuleCount: 271,
        },
        revision: "rev-1",
        ruleSummary: { total: 271, builtin: 271, custom: 0 },
        overview: {
          counters: {
            scanned: 0,
            masked: 0,
            detected: 0,
            blocked: 0,
            passthrough: 0,
            demaskWarning: 0,
            toolArgumentRestoreSkipped: 0,
          },
          topRules: [],
          topCategories: [],
          recentEvents: [],
          lastPassthroughAt: null,
          retention: {
            kind: "in-memory",
            ttlMs: 3_600_000,
            maxEvents: 1_000,
            maxBytes: 2_097_152,
            currentEvents: 0,
            currentBytes: 0,
            evictedEvents: 0,
            oldestAt: null,
            lastEventAt: null,
          },
        },
      });
    }
    return json({});
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });

  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => { mounted.unmount(); });
    root = null;
  }
  const { resetApiAuthFetchForTests } = await import("../src/api");
  resetApiAuthFetchForTests();
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previousGlobals[key],
    });
  }
});

test("the #guardrails route mounts the Guardrails workspace and activates its navigation item", async () => {
  const { resetApiAuthFetchForTests, installApiAuthFetch } = await import("../src/api");
  resetApiAuthFetchForTests();
  installApiAuthFetch();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: testWindow.fetch,
  });
  const [{ createRoot }, { LanguageProvider }, { default: App }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/App"),
  ]);

  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <App />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise(resolve => testWindow.setTimeout(resolve, 30));
  });

  expect(host.textContent).toContain("Sensitive data guardrails");
  expect(host.querySelector('[data-page="guardrails"]')?.getAttribute("aria-current"))
    .toBe("page");
  expect(host.querySelector("#guardrails-panel-overview")).not.toBeNull();
});
