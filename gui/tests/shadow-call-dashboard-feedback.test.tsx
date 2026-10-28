import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { useDashboardData } from "../src/pages/use-dashboard-data";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof fetch;

type Dash = ReturnType<typeof useDashboardData>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  root = null;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
  }
  root = null;
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function shadowSettings() {
  return {
    enabled: true,
    model: "xai/grok-4.5",
    sourceModels: ["gpt-6-luna"],
    sourceModelOptions: [{ id: "gpt-6-luna", role: "helper", defaultIntercepted: true }],
  };
}

function mockDashboardFetch(put: () => Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/api/shadow-call-settings")) {
      if (init?.method === "PUT") return put();
      return Response.json(shadowSettings());
    }
    if (path.endsWith("/api/sidecar-settings")) {
      return Response.json({
        webSearch: { model: "gpt-5.6-luna", streamRoutedModelOutput: false },
        vision: {
          model: "gpt-5.6-luna", backend: "openai", reasoning: "low",
          enabled: true, maxDescriptionsPerTurn: 12, timeoutMs: 30_000,
        },
      });
    }
    if (path.endsWith("/api/settings")) {
      return Response.json({ port: 10100, hostname: "127.0.0.1" });
    }
    if (path.endsWith("/api/providers")) return Response.json({ providers: [] });
    return Response.json({});
  }) as typeof fetch;
}

async function mountDashboard(fetchImpl: typeof fetch): Promise<() => Dash> {
  globalThis.fetch = fetchImpl;
  let latest: Dash | undefined;
  function Harness() {
    const data = useDashboardData("/shadow-feedback");
    useEffect(() => { latest = data; }, [data]);
    return null;
  }
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Harness /></LanguageProvider>);
  });
  if (!latest) throw new Error("dashboard hook did not mount");
  return () => latest!;
}

test("a rejected dashboard source save restores the previous list and publishes localized feedback", async () => {
  const data = await mountDashboard(mockDashboardFetch(async () =>
    Response.json({ error: "bad source", code: "shadow_call_source_invalid" }, { status: 400 })));

  await act(async () => { await data().saveShadowCall({ sourceModels: ["gpt-6-luna", "gpt-6.1-terra"] }); });

  expect(data().shadowCall?.sourceModels).toEqual(["gpt-6-luna"]);
  expect(data().shadowCallError).toBe(en["models.shadowCallSourceInvalid"]);
});

test("a failed dashboard fetch reports a network error instead of a validation message", async () => {
  const data = await mountDashboard(mockDashboardFetch(async () => {
    throw new Error("offline");
  }));

  await act(async () => { await data().saveShadowCall({ sourceModels: ["gpt-6-luna", "gpt-6.1-terra"] }); });

  expect(data().shadowCall?.sourceModels).toEqual(["gpt-6-luna"]);
  expect(data().shadowCallError).toBe(en["models.networkError"]);
});
