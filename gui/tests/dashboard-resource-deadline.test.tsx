import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { LanguageProvider } from "../src/i18n/provider";
import { useDashboardData } from "../src/pages/use-dashboard-data";
import { clearClientResourceStoresForTests } from "../src/client-resource";

test("a controlled overview deadline marks retained dashboard data stale", async () => {
  const keys = ["window", "document", "navigator", "sessionStorage", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.document, "visibilityState", { configurable: true, value: "hidden" });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator,
    sessionStorage: win.sessionStorage, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const originalTimeout = globalThis.setTimeout;
  let deadline: (() => void) | undefined;
  let stall = false;
  let started = false;
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (stall && ms === 30_000 && !deadline) deadline = () => callback(...args);
    return originalTimeout(callback, ms, ...args);
  } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/api/system/health")) {
      if (stall) {
        started = true;
        return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
      }
      return Response.json({ status: "ok", version: "fixture", uptime: 10 });
    }
    if (path.endsWith("/api/providers") || path.endsWith("/api/models")) return Response.json([]);
    return new Response(null, { status: 404 });
  } });
  clearClientResourceStoresForTests();
  let data: ReturnType<typeof useDashboardData> | undefined;
  function Probe() {
    data = useDashboardData("/deadline");
    return <span>{data.error ? "stale" : "fresh"}:{data.health?.version}</span>;
  }
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const root = createRoot(host);
  const waitFor = async (predicate: () => boolean) => {
    const until = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() >= until) throw new Error("dashboard fixture did not settle");
      await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
    }
  };
  try {
    await act(async () => { root.render(<LanguageProvider><Probe /></LanguageProvider>); });
    await waitFor(() => data?.health?.version === "fixture");
    expect(host.textContent).toBe("fresh:fixture");
    stall = true;
    await act(async () => { data!.refreshDashboard(); });
    await waitFor(() => started && deadline !== undefined);
    await act(async () => { deadline!(); });
    await waitFor(() => data?.error === true);
    expect(host.textContent).toBe("stale:fixture");
    expect(data!.connectionFailure).toBe("unavailable");
  } finally {
    await act(async () => { root.unmount(); });
    clearClientResourceStoresForTests();
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, writable: true, value: originalTimeout });
    win.close();
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
