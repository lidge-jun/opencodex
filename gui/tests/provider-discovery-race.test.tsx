import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import AddProviderModal from "../src/components/AddProviderModal";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
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
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("stale discovery responses cannot overwrite a changed endpoint or provider", async () => {
  const discoveryResolvers: Array<(response: Response) => void> = [];
  const deferredDiscoveries: Promise<Response>[] = [];
  const discoverySignals: Array<AbortSignal | undefined> = [];

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/oauth/providers")) return Promise.resolve(Response.json({ providers: [] }));
    if (url.endsWith("/api/usage?range=30d")) return Promise.resolve(Response.json({ providers: [] }));
    if (url.endsWith("/api/provider-presets")) {
      return Promise.resolve(Response.json({
        providers: [
          {
            id: "alpha",
            label: "Alpha",
            adapter: "openai-chat",
            baseUrl: "https://alpha-cn.example/v1",
            auth: "key",
            baseUrlChoices: [
              { id: "china-mainland", label: "China mainland", baseUrl: "https://alpha-cn.example/v1" },
              { id: "international", label: "International", baseUrl: "https://alpha-global.example/v1" },
            ],
            accessGroups: ["recurring-or-keyless"],
            supportLevel: "supported",
            verification: "official",
            discovery: "live",
            liveModels: true,
          },
          {
            id: "beta",
            label: "Beta",
            adapter: "openai-chat",
            baseUrl: "https://beta.example/v1",
            auth: "key",
            accessGroups: ["recurring-or-keyless"],
            supportLevel: "supported",
            verification: "official",
            discovery: "static",
            liveModels: false,
            models: ["beta-static"],
            defaultModel: "beta-static",
          },
        ],
      }));
    }
    if (url.endsWith("/api/provider-presets/discover")) {
      const requestIndex = deferredDiscoveries.length;
      discoverySignals.push(init?.signal ?? undefined);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        presetId: "alpha",
        provider: {
          baseUrl: requestIndex === 0 ? "https://alpha-cn.example/v1" : "https://alpha-global.example/v1",
        },
      });
      const deferred = new Promise<Response>(resolve => { discoveryResolvers.push(resolve); });
      deferredDiscoveries.push(deferred);
      return deferred;
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <AddProviderModal
          apiBase=""
          existingNames={[]}
          onClose={() => {}}
          onAdded={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise(resolve => window.setTimeout(resolve, 0));
  });

  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.includes(label));

  await act(async () => { button("Alpha")!.click(); });
  await act(async () => { button("Discover models")!.click(); });
  expect(discoverySignals[0]?.aborted).toBe(false);

  const endpointSelect = [...container.querySelectorAll<HTMLLabelElement>("label")]
    .find(label => label.textContent?.includes("Endpoint"))
    ?.querySelector<HTMLSelectElement>("select");
  expect(endpointSelect).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
      .set!.call(endpointSelect, "international");
    endpointSelect!.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  expect(endpointSelect?.value).toBe("international");
  expect(discoverySignals[0]?.aborted).toBe(true);

  await act(async () => {
    discoveryResolvers[0]!(Response.json({ ok: true, source: "live", models: [{ id: "alpha-cn-stale" }] }));
    await deferredDiscoveries[0];
    await Promise.resolve();
  });
  expect(container.textContent).not.toContain("alpha-cn-stale");

  await act(async () => { button("Discover models")!.click(); });
  expect(discoverySignals[1]?.aborted).toBe(false);

  await act(async () => { button("Beta")!.click(); });
  expect(discoverySignals[1]?.aborted).toBe(true);
  expect(container.textContent).toContain("beta-static");

  await act(async () => {
    discoveryResolvers[1]!(Response.json({ ok: true, source: "live", models: [{ id: "alpha-global-stale" }] }));
    await deferredDiscoveries[1];
    await Promise.resolve();
  });

  expect(container.textContent).toContain("Beta");
  expect(container.textContent).toContain("beta-static");
  expect(container.textContent).not.toContain("alpha-global-stale");
  const defaultModelInput = [...container.querySelectorAll<HTMLLabelElement>("label")]
    .find(label => label.textContent?.includes("Default model"))
    ?.querySelector<HTMLInputElement>("input");
  expect(defaultModelInput?.value).toBe("beta-static");

  await act(async () => { root.unmount(); });
});
