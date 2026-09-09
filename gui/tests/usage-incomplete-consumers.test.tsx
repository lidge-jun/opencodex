import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { readSessionListCache } from "../src/session-list-cache";
import { readUsageMetadata } from "../src/usage-summary-resource";
import { DashboardOverviewHead } from "../src/pages/dashboard-overview-head";
import ProviderWorkspaceShell from "../src/components/provider-workspace/ProviderWorkspaceShell";
import AddProviderModal from "../src/components/AddProviderModal";
import ApiKeys from "../src/pages/ApiKeys";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Map<string, PropertyDescriptor | undefined>;
let win: Window, host: HTMLElement, root: Root | null;
let usageBody: Record<string, unknown>, keysBody: Record<string, unknown>;
let hold = false;
const partial = { usageIncomplete: true, usageIncompleteReason: "oversized_rows" };
const warning = "Some usage records could not be included";

beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  win.localStorage.setItem("ocx-lang", "en");
  const values = { document: win.document, window: win, navigator: win.navigator,
    localStorage: win.localStorage, sessionStorage: win.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  root = null; hold = false;
  usageBody = { ...partial, providers: [], models: [] };
  keysBody = { ...partial, keys: [], authMatrix: [{ endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" }] };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    if (hold) return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new Error("aborted"));
      else init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const path = String(input);
    const body = path.includes("/api/usage?") ? usageBody
      : path.endsWith("/api/keys") ? keysBody
      : path.endsWith("/api/models") ? []
      : path.endsWith("/v1/models") ? { data: [] }
      : path.endsWith("/api/selected-models") ? { selected: {}, available: {}, liveModelCounts: {} }
      : path.includes("/api/provider-quotas") ? { reports: [] }
      : path.endsWith("/api/oauth/providers") ? { providers: [] }
      : path.endsWith("/api/provider-presets") ? { providers: [{ id: "test", label: "Test", adapter: "openai-chat", baseUrl: "https://example.test", auth: "key" }] }
      : {};
    return Response.json(body);
  } });
  host = document.createElement("div"); document.body.append(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  clearClientResourceStoresForTests();
  win.close();
  for (const key of globals) {
    const descriptor = previous.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function mount(node: ReactNode) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root ??= createRoot(host); root.render(<LanguageProvider>{node}</LanguageProvider>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
}
async function remountFromCache(node: ReactNode) {
  await act(async () => { root!.unmount(); }); root = null;
  clearClientResourceStoresForTests(); hold = true;
  await mount(node);
}

test("metadata reader preserves positive diagnostics without inferring completeness or copying fields", () => {
  for (const value of [null, {}, { usageIncomplete: false }, { usageIncomplete: "true" }]) expect(readUsageMetadata(value)).toEqual({});
  expect(readUsageMetadata({ ...partial, models: [1], token: "private" })).toEqual(partial);
  expect(readUsageMetadata({ usageIncomplete: true, usageIncompleteReason: "future_reason" })).toEqual({ usageIncomplete: true });
});

test("Dashboard warns even when no readable requests remain", async () => {
  await mount(<DashboardOverviewHead locale="en" health={null} providers={[]}
    usage30d={{ ...partial, summary: { requests: 0, totalTokens: 0, coverageRatio: 0 } } as never}
    usageLoading={false} healthLoading={false} startupHealth={null} projectConfigWarnings={[]}
    maMode="default" maBusy={false} maHelpTriggerRef={{ current: null }} maHelpOpen={false}
    setMaHelpOpen={() => {}} switchMaMode={async () => {}} maError={null} />);
  expect(host.textContent).toContain(warning);
});

test("provider usage projection retains incomplete metadata through a cache-only revisit", async () => {
  usageBody = { ...partial, providers: [{ provider: "test", requests: 7, totalTokens: 123 }], models: [] };
  const node = <ProviderWorkspaceShell apiBase="/provider" providers={{ test: { adapter: "openai-chat", authMode: "key", baseUrl: "https://example.test" } } as never}
    defaultProvider="test" selectedName={null} onSelect={() => {}} onAddProvider={() => {}} />;
  await mount(node);
  expect(host.textContent).toContain(warning);
  const cached = readSessionListCache<Record<string, unknown>>("ocx.providers.usage.v2:/provider");
  expect(cached).toMatchObject({ ...partial, totals: { test: { requests: 7, totalTokens: 123 } } });
  await remountFromCache(node);
  expect(host.textContent).toContain(warning);
});

test("provider catalog explains that its usage ranking can be incomplete without any readable rows", async () => {
  await mount(<AddProviderModal apiBase="/add" existingNames={[]} onClose={() => {}} onAdded={() => {}} />);
  expect(host.textContent).toContain(warning);
});

test("API key fetch and session cache retain incomplete metadata even without attribution or keys", async () => {
  const node = <ApiKeys apiBase="/keys" />;
  await mount(node);
  expect(host.textContent).toContain(warning);
  const cached = readSessionListCache<Record<string, unknown>>("ocx.apikeys.list.v2:/keys");
  expect(cached).toMatchObject({ ...partial, keys: [] });
  expect(cached).not.toHaveProperty("attributionSince");
  await remountFromCache(node);
  expect(host.textContent).toContain(warning);
});
