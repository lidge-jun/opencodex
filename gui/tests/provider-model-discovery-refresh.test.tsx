import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderModelDiscovery from "../src/components/provider-workspace/ProviderModelDiscovery";
import { buildConnectionProbeKey } from "../src/components/provider-workspace/use-provider-probe-state";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

/**
 * The manual "discover now" panel reads the recent arrivals once on mount and again from the
 * refresh answer. A slow mount read that lands after the refresh must not put the pre-refresh
 * list back, or the models the refresh just reported vanish under its own success line.
 */

const DOM_GLOBALS = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previousLanguage: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLanguage = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousLanguage) Object.defineProperty(globalThis.navigator, "language", previousLanguage);
  else delete (globalThis.navigator as { language?: string }).language;
});

test("a mount read answering after a finished refresh does not replace the refreshed list", async () => {
  const previous = Object.fromEntries(DOM_GLOBALS.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  let releaseInitial!: (response: Response) => void;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/model-discovery")) return new Promise<Response>(resolve => { releaseInitial = resolve; });
    if (url.endsWith("/api/model-discovery/refresh")) {
      return Response.json({
        ok: true, discovery: { status: "ok" }, liveModelCount: 2,
        newArrivals: [{ id: "fresh-model", at: "2026-11-12T00:00:00Z", state: "enabled" }],
        recentArrivals: [
          { id: "old-model", at: "2026-11-01T00:00:00Z", state: "enabled" },
          { id: "fresh-model", at: "2026-11-12T00:00:00Z", state: "enabled" },
        ],
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  let root: Root | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(<LanguageProvider><ProviderModelDiscovery apiBase="http://localhost" provider="live" /></LanguageProvider>);
    });
    const button = container.querySelector("button") as unknown as HTMLButtonElement;
    await act(async () => { button.click(); });
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
    expect(container.textContent).toContain("fresh-model");

    // The mount read answers last, with the roster from before the refresh.
    await act(async () => {
      releaseInitial(Response.json({ recentArrivals: { live: [{ id: "old-model", at: "2026-11-01T00:00:00Z" }] } }));
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain("fresh-model");
    expect(container.textContent).toContain("old-model");
  } finally {
    if (root) await act(async () => root?.unmount());
    container.remove();
    testWindow.close();
    for (const key of DOM_GLOBALS) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("a change in server-side Vertex verification discards a retained connection probe", () => {
  const item = { name: "google-vertex", adapter: "google", baseUrl: "https://aiplatform.googleapis.com" } as WorkspaceItem;
  const verified = buildConnectionProbeKey("http://localhost", { ...item, vertexCredentialVerified: true });
  const lapsed = buildConnectionProbeKey("http://localhost", { ...item, vertexCredentialVerified: false });
  expect(lapsed).not.toBe(verified);
  expect(buildConnectionProbeKey("http://localhost", item)).toBe(lapsed);
});
