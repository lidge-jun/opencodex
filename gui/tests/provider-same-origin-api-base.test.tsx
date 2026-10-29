import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { acceptActionDialog } from "./helpers/action-dialog";

// The packaged dashboard is served by the proxy itself and, unless it discovers another
// target, talks to it same-origin with apiBase "" (App.tsx: VITE_API_BASE || ""). An empty
// base is a real server, not a missing one: probes and settings reads use root-relative URLs.

const globals = ["document", "window", "navigator", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let win: Window;
let root: Root | undefined;
let host: HTMLElement;
let requests: Array<{ url: string; init?: RequestInit }>;
const originalFetch = globalThis.fetch;
const item: WorkspaceItem = { name: "local vendor", adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1",
  hasApiKey: true, models: ["configured"], defaultModel: "configured" };

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator,
    localStorage: win.localStorage, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  host = document.createElement("div"); document.body.append(host);
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const url = String(input);
    if (url === "/api/provider-presets") {
      return Response.json({ providers: [{ id: item.name, baseUrlChoices: [
        { id: "region-a", label: "Region A", baseUrl: item.baseUrl },
        { id: "region-b", label: "Region B", baseUrl: "http://127.0.0.2:9/v1" },
      ] }] });
    }
    if (url.startsWith("/api/provider-request-pacing")) {
      return Response.json({ enabled: true, queued: 3, nextSlotInMs: 250, lastModelId: "configured" });
    }
    return Response.json({ applicable: true, ok: true, latencyMs: 3 });
  }) as typeof fetch;
});
afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = undefined;
  globalThis.fetch = originalFetch;
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
});

async function mount(node: React.ReactNode) {
  const { createRoot } = await import("react-dom/client");
  root = createRoot(host);
  await act(async () => { root!.render(<LanguageProvider>{node}</LanguageProvider>); });
}
function button(label: string) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === label);
}

test("same-origin overview shows both provider probes and sends root-relative requests", async () => {
  await mount(<ProviderOverview item={item} apiBase="" availableModels={["configured"]} />);
  expect(host.querySelector('[aria-label="Model completion test"]')).not.toBeNull();
  const connection = button("Test connection");
  expect(connection).toBeTruthy();
  await act(async () => { connection!.click(); });
  expect(requests.map(r => r.url)).toEqual(["/api/providers/test?name=local%20vendor"]);
  expect(requests[0]!.init?.method).toBe("POST");

  await act(async () => { host.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Model to test"]')!.click(); });
  const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(o => o.textContent === "configured")!;
  await act(async () => { option.click(); });
  await act(async () => { button("Test model")!.click(); });
  await act(async () => { acceptActionDialog(document); });
  expect(requests.map(r => r.url)).toEqual([
    "/api/providers/test?name=local%20vendor",
    "/api/providers/test-completion?name=local%20vendor",
  ]);
  expect(requests[1]!.init?.method).toBe("POST");
  expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({ model: "configured", confirm: true });
});

test("overview without any api base renders no probes and sends nothing", async () => {
  await mount(<ProviderOverview item={item} availableModels={["configured"]} />);
  expect(button("Test connection")).toBeUndefined();
  expect(host.querySelector('[aria-label="Model completion test"]')).toBeNull();
  expect(requests).toHaveLength(0);
});

test("same-origin settings loads and renders endpoint choices and request pacing status", async () => {
  await mount(<ProviderSettings item={item} apiBase="" availableModels={["configured"]}
    onUpdateProvider={async () => ({ ok: true })} />);
  await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 0)); });
  const urls = requests.map(r => r.url);
  expect(urls).toContain("/api/provider-presets");
  expect(urls).toContain("/api/provider-request-pacing?name=local%20vendor");
  // The endpoint picker is built from the preset response and preselects the saved base URL.
  const endpoint = Array.from(host.querySelectorAll<HTMLSelectElement>("select"))
    .find(select => Array.from(select.options).some(option => option.value === "region-b"));
  expect(endpoint).toBeTruthy();
  expect(Array.from(endpoint!.options).map(option => option.value)).toEqual(["region-a", "region-b"]);
  expect(endpoint!.value).toBe("region-a");
  // The live pacing status comes from the pacing response.
  const pacing = host.querySelector(".pwi-pacing-status")!.textContent ?? "";
  expect(pacing).toContain("3");
  expect(pacing).toContain("250 ms");
  expect(pacing).toContain("configured");
});
