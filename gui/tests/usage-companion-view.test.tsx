import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Usage from "../src/pages/Usage";

test("companion settings use config providers when the usage report fails", async () => {
  const keys = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "IntersectionObserver", "__APP_VERSION__"] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const browser = new Window({ url: "http://localhost/#usage/companion" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: browser.document },
    window: { configurable: true, value: browser },
    navigator: { configurable: true, value: browser.navigator },
    localStorage: { configurable: true, value: browser.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    __APP_VERSION__: { configurable: true, value: "test" },
    IntersectionObserver: { configurable: true, value: class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    } },
  });
  const settings = {
    menuBarMetric: "tokens", menuBarTemplate: null, showToday: true, showChart: false,
    showModels: false, showCost: false, showAccounts: false, chartHours: 24,
    bucketMinutes: 60, chartStyle: "line", tokenMetric: "total", aggregation: "sum",
    chartGrouping: "model", models: null, hiddenProviders: [],
  };
  const requests: string[] = [];
  const saves: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/api/usage?")) return Response.json({ error: "unavailable" }, { status: 503 });
    if (url.endsWith("/api/config")) return Response.json({ providers: { alpha: {}, beta: {} } });
    if (url.endsWith("/api/companion/settings") && init?.method === "PUT") {
      saves.push(String(init.body));
      return Response.json({ settings, defaults: settings, updatedAt: 1 });
    }
    if (url.endsWith("/api/companion/settings")) return Response.json({ settings, defaults: settings, updatedAt: null });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  clearClientResourceStoresForTests();
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(LanguageProvider, null, createElement(Usage, { apiBase: "http://failed-usage-test" }))));
    const deadline = Date.now() + 2_000;
    while (!host.querySelector('.usage-companion-check-list input[type="checkbox"]')) {
      if (Date.now() >= deadline) throw new Error("Config provider controls did not render");
      await act(async () => { await new Promise(resolve => browser.setTimeout(resolve, 10)); });
    }
    const providers = [...host.querySelectorAll(".usage-companion-check-list label")].map(label => label.textContent?.trim());
    expect(providers).toEqual(["alpha", "beta"]);
    expect(host.querySelector('[role="tabpanel"]')?.id).toBe("usage-panel-companion");
    expect(host.querySelector(".usage-workspace-shell")).toBeNull();
    expect(requests.some(url => url.includes("/api/usage?"))).toBe(true);
    expect(requests.some(url => url.endsWith("/api/config"))).toBe(true);
    // An edit still inside the 300 ms autosave delay survives an immediate switch to the report.
    await act(async () => {
      (host.querySelector('.usage-companion-check-list input[type="checkbox"]') as HTMLInputElement).click();
    });
    expect(saves).toHaveLength(0);
    await act(async () => {
      browser.location.hash = "#usage";
      browser.dispatchEvent(new browser.Event("hashchange"));
    });
    expect(host.querySelector('[aria-selected="true"]')?.id).toBe("usage-tab-report");
    expect(host.querySelector(".usage-companion-panel")).toBeNull();
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0]!).settings.hiddenProviders).toEqual(["alpha"]);
    await act(async () => {
      browser.location.hash = "#usage/companion";
      browser.dispatchEvent(new browser.Event("hashchange"));
    });
    expect(host.querySelector('[aria-selected="true"]')?.id).toBe("usage-tab-companion");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    clearClientResourceStoresForTests();
    browser.close();
    if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
    else Reflect.deleteProperty(globalThis, "fetch");
    for (const key of keys) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
