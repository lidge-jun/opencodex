import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import ProviderWorkspaceShell from "../src/components/provider-workspace/ProviderWorkspaceShell";
import ProviderModels from "../src/components/provider-workspace/ProviderModels";
import { LanguageProvider } from "../src/i18n/provider";
import type { ModelRow } from "../src/pages/models-shared";
import type { WorkspaceProvider } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let root: Root | undefined;
let host: HTMLElement;
let rows: ModelRow[];
let custom: Array<{ id: string; provider: string; modelId: string }>;
let selected: Record<string, string[]>;
let available: Record<string, string[]>;
let requests: Array<{ path: string; method: string; body?: unknown }>;
let reads: Record<string, number>;
let recovery: number;
const unmountedControl = () => { throw new Error("Provider management harness is not mounted"); };
let refresh: () => void = unmountedControl;
let choose: (name: string) => void = unmountedControl;
let deleteMode: "ok" | "reject" | "lost" | "malformed" | "refresh-failed";
let underlying: ModelRow | undefined;
let writeGate: Promise<void> | undefined;
const queues = new Map<string, Array<{ arrived: () => void; response: Promise<Response> }>>();
const committed = { status: "committed", changed: true, degraded: false, notices: [] };
const providers: Record<string, WorkspaceProvider> = {
  vendor: { adapter: "openai-chat", baseUrl: "https://vendor.invalid/v1", hasApiKey: true },
  openai: { adapter: "openai-responses", baseUrl: "https://openai.invalid/v1", authMode: "forward" },
  other: { adapter: "openai-chat", baseUrl: "https://other.invalid/v1", hasApiKey: true },
};
const row = (id: string, extra: Partial<ModelRow> = {}): ModelRow => ({ provider: "vendor", id, namespaced: `vendor/${id}`, disabled: false, ...extra });

function hold(path: string) {
  let arrived!: () => void; let release!: (response: Response) => void;
  const started = new Promise<void>(resolve => { arrived = resolve; });
  const response = new Promise<Response>(resolve => { release = resolve; });
  queues.set(path, [...(queues.get(path) ?? []), { arrived, response }]);
  return { started, release };
}
function selection() { return { selected, available, liveModelCounts: { vendor: 2, openai: 0, other: 1 } }; }
function addCustom(id = "custom-1", provider = "vendor", modelId = "custom-model") {
  custom.push({ id, provider, modelId });
  rows.push(row(modelId, { provider, namespaced: `${provider}/${modelId}`, custom: true, customId: id }));
}
async function api(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input), "http://localhost").pathname;
  const method = init?.method ?? "GET";
  if (method === "GET") {
    reads[path] = (reads[path] ?? 0) + 1;
    const queued = queues.get(path)?.shift();
    if (queued) { queued.arrived(); return queued.response; }
    if (path === "/api/models") return Response.json(rows);
    if (path === "/api/selected-models") return Response.json(selection());
    if (path === "/api/custom-models") return Response.json(custom);
    if (path === "/api/provider-quotas") return Response.json({ reports: [] });
    if (path === "/api/usage") return Response.json({ providers: [], models: [] });
    throw new Error(`Unexpected read: ${path}`);
  }
  const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ path, method, ...(body === undefined ? {} : { body }) });
  if (writeGate) await writeGate;
  if (method === "POST" && path === "/api/custom-models") {
    const target = body as { provider: string; modelId: string };
    if (custom.some(value => value.provider === target.provider && value.modelId === target.modelId)) return Response.json({ error: "duplicate model" }, { status: 409 });
    addCustom("readded-id", target.provider, target.modelId);
    return Response.json({ id: "readded-id", ...target, catalogRefresh: committed }, { status: 201 });
  }
  if (method === "DELETE") {
    const id = decodeURIComponent(path.split("/").at(-1)!);
    const record = custom.find(value => value.id === id);
    if (!record || deleteMode === "reject") return Response.json({ error: "not found" }, { status: 404 });
    custom = custom.filter(value => value.id !== id);
    rows = rows.filter(value => value.customId !== id);
    if (underlying) rows.push({ ...underlying });
    if (deleteMode === "lost") throw new Error("transport lost after deletion");
    if (deleteMode === "malformed") return new Response("{", { status: 200 });
    return Response.json({ ok: true, catalogRefresh: deleteMode === "refresh-failed"
      ? { status: "failed", reason: "disk", phase: "commit", retryable: false, partialWrite: true }
      : committed });
  }
  if (method === "PUT" && path === "/api/model-visibility") {
    const target = body as { scope: string; provider: string; targets: Array<{ id: string; native?: boolean }>; enabled: boolean };
    for (const entry of target.targets) {
      const found = rows.find(value => value.provider === target.provider && value.id === entry.id && (value.native === true) === (entry.native === true));
      if (!found || found.custom) return Response.json({ error: "invalid target" }, { status: 400 });
      found.disabled = !target.enabled;
    }
    return Response.json({ ok: true, scope: target.scope, provider: target.provider, enabled: target.enabled,
      disabled: rows.filter(value => value.disabled).map(value => value.namespaced), catalogRefresh: committed });
  }
  throw new Error(`Unexpected write: ${method} ${path}`);
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({ document: win.document, window: win, navigator: win.navigator,
    localStorage: win.localStorage, sessionStorage: win.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  win.confirm = () => true;
  rows = []; custom = []; selected = {}; available = {}; requests = []; reads = {}; recovery = 0;
  deleteMode = "ok"; underlying = undefined; writeGate = undefined; queues.clear();
  globalThis.fetch = api as typeof fetch;
  host = document.createElement("div"); document.body.append(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined; globalThis.fetch = originalFetch;
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

// Observe DOM state, not elapsed time. Timeout is only a failing-test bound.
function observed(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new win.MutationObserver(() => {
      if (!predicate()) return;
      observer.disconnect(); clearTimeout(timeout); resolve();
    });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`DOM condition not reached: ${host.textContent}`)); }, 3000);
    observer.observe(host as never, { childList: true, subtree: true, attributes: true, characterData: true });
  });
}
const actionButtons = () => [...host.querySelectorAll<HTMLButtonElement>('.pws-model-chip button[aria-label^="Hide: "], .pws-model-chip button[aria-label^="Delete: "]')];
const actionable = () => actionButtons().filter(button => !button.disabled);
const chip = (selector: string) => [...host.querySelectorAll<HTMLElement>(".pws-model-chip")].find(value => value.querySelector(".pws-model-chip-main")?.getAttribute("title") === selector)!;
function action(selector: string, kind: "Delete" | "Hide"): HTMLButtonElement {
  const expectedName = `${kind}: ${selector}`;
  const matches = [...chip(selector).querySelectorAll<HTMLButtonElement>("button")]
    .filter(button => button.getAttribute("aria-label") === expectedName);
  expect(matches).toHaveLength(1);
  expect(matches[0]!.title).toBe(expectedName);
  return matches[0]!;
}
const ids = () => [...host.querySelectorAll(".pws-model-id")].map(node => node.textContent);
const feedback = () => [...host.querySelectorAll('[role="alert"], [role="status"]')].map(node => node.textContent).join(" ");
async function waitFor(predicate: () => boolean) {
  // Let React finish effects before awaiting a future DOM transition in a separate turn.
  await act(async () => {});
  await observed(predicate);
  await act(async () => {});
}
async function mount(name = "vendor") {
  function Harness() {
    const [epoch, setEpoch] = useState(0); const [provider, setProvider] = useState(name);
    useEffect(() => {
      const committedRefresh = () => setEpoch(value => value + 1);
      refresh = committedRefresh;
      choose = setProvider;
      return () => {
        if (refresh === committedRefresh) refresh = unmountedControl;
        if (choose === setProvider) choose = unmountedControl;
      };
    }, []);
    return <ProviderWorkspaceShell providers={providers} apiBase="http://localhost:10100" defaultProvider="vendor"
      selectedName={provider} onSelect={value => setProvider(value ?? "vendor")} onAddProvider={() => {}}
      modelsRefreshToken={epoch} detail={(item, data) => <section>
        <output data-testid="parent-ready" data-ready={String(data.modelRowsReady)} />
        <ProviderModels key={item.name} item={item} {...data} apiBase="http://localhost:10100" onOpenModels={() => { recovery += 1; }} />
      </section>} />;
  }
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root = createRoot(host); root.render(<LanguageProvider><Harness /></LanguageProvider>); });
}
async function click(button: HTMLButtonElement) { expect(button).toBeDefined(); await act(async () => { button.click(); }); }
async function current() { await waitFor(() => host.querySelector('[data-testid="parent-ready"]')?.getAttribute("data-ready") === "true"); }
async function refreshCurrent() { await act(async () => { refresh(); }); await current(); }

for (const counterpart of ["native", "discovered", "none"] as const) {
  test(`DELETE only: ${counterpart} counterpart is reconciled without a visibility tombstone`, async () => {
    const provider = counterpart === "native" ? "openai" : "vendor";
    addCustom("stable/id", provider, "same");
    if (counterpart !== "none") underlying = row("same", { provider, namespaced: counterpart === "native" ? "same" : "vendor/same", native: counterpart === "native" });
    rows.push(row("independently-hidden", { provider, namespaced: `${provider}/independently-hidden`, disabled: true }));
    selected = { [provider]: ["another"] };
    await mount(provider); await waitFor(() => actionable().length === 1);
    await click(action(`${provider}/same`, "Delete"));
    await waitFor(() => feedback().includes("Custom definition deleted")); await current();
    expect(requests).toEqual([{ path: "/api/custom-models/stable%2Fid", method: "DELETE" }]);
    expect(custom).toEqual([]); expect(selected).toEqual({ [provider]: ["another"] });
    expect(rows.find(value => value.id === "independently-hidden")?.disabled).toBe(true);
    expect(ids()).toEqual(counterpart === "none" ? [] : ["same"]);
    await refreshCurrent(); expect(ids()).toEqual(counterpart === "none" ? [] : ["same"]);
  });
}

test("same-label custom and account-native rows keep disjoint Delete/Hide identities", async () => {
  const id = "account-work/gpt-5.5";
  const nativeSelector = id;
  const customSelector = "openai/account-work-gpt-5.5";
  custom = [{ id: "override", provider: "openai", modelId: id }];
  rows = [row(id, { provider: "openai", namespaced: nativeSelector, native: true }),
    row(id, { provider: "openai", namespaced: customSelector, custom: true, customId: "override" })];
  await mount("openai"); await waitFor(() => actionable().length === 2);
  expect(ids()).toEqual([nativeSelector, customSelector]);
  expect(actionButtons().map(button => button.getAttribute("aria-label"))).toEqual([
    "Hide: account-work/gpt-5.5", "Delete: openai/account-work-gpt-5.5",
  ]);
  expect(actionButtons().map(button => button.title)).toEqual([
    "Hide: account-work/gpt-5.5", "Delete: openai/account-work-gpt-5.5",
  ]);
  expect([...host.querySelectorAll(".pws-model-chip-main")].map(button => button.getAttribute("aria-label")))
    .toEqual(["Copy ID", "Copy ID"]);
  await click(action(customSelector, "Delete")); await waitFor(() => ids().length === 1);
  expect(requests).toEqual([{ path: "/api/custom-models/override", method: "DELETE" }]);
  expect(rows[0]?.disabled).toBe(false);
  await refreshCurrent(); expect(ids()).toEqual([id]);
  await waitFor(() => actionable().length === 1); await click(action(nativeSelector, "Hide"));
  await waitFor(() => ids().length === 0);
  expect(requests[1]?.body).toEqual({ scope: "models", provider: "openai", targets: [{ id, native: true }], enabled: false });
  const recover = [...host.querySelectorAll("button")].find(button => button.textContent === "Manage visibility in Models")!;
  await click(recover); expect(recovery).toBe(1);
});

for (const customRow of [true, false]) {
  test(`cancel ${customRow ? "Delete" : "Hide"} sends no write and preserves the row`, async () => {
    if (customRow) addCustom(); else rows = [row("custom-model")];
    win.confirm = () => false; await mount(); await waitFor(() => actionable().length === 1);
    await click(action("vendor/custom-model", customRow ? "Delete" : "Hide")); expect(requests).toEqual([]); expect(ids()).toEqual(["custom-model"]);
  });
}

for (const mode of ["reject", "lost", "malformed", "refresh-failed"] as const) {
  test(`DELETE ${mode} reconciles persisted truth, preserves feedback and never PUTs`, async () => {
    addCustom(); deleteMode = mode; await mount(); await waitFor(() => actionable().length === 1);
    await click(action("vendor/custom-model", "Delete"));
    await waitFor(() => feedback().includes(mode === "refresh-failed" ? "could not be refreshed" : mode === "reject" ? "Failed" : "could not be confirmed"));
    await current();
    expect(requests).toEqual([{ path: "/api/custom-models/custom-1", method: "DELETE" }]);
    expect(ids()).toEqual(mode === "reject" ? ["custom-model"] : []);
    expect(custom).toHaveLength(mode === "reject" ? 1 : 0);
    expect((reads["/api/custom-models"] ?? 0)).toBeGreaterThan(1);
    expect((reads["/api/models"] ?? 0)).toBeGreaterThan(1);
    expect(host.querySelector('[role="alert"], [role="status"]')).not.toBeNull();
  });
}

test("single flight blocks a second row until the first write and all reconciliation reads finish", async () => {
  addCustom(); rows.push(row("second")); let releaseWrite!: () => void;
  writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  await mount(); await waitFor(() => actionable().length === 2);
  const first = action("vendor/custom-model", "Delete"); const second = action("vendor/second", "Hide");
  await act(async () => { first.click(); second.click(); }); expect(requests).toHaveLength(1);
  const inventory = hold("/api/models"); const ownership = hold("/api/custom-models");
  await act(async () => { releaseWrite(); }); await inventory.started; await ownership.started;
  expect(actionable()).toEqual([]);
  await act(async () => { inventory.release(Response.json(rows)); }); await current(); expect(actionable()).toEqual([]);
  await act(async () => { ownership.release(Response.json(custom)); });
  await waitFor(() => actionable().length === 1); expect(requests).toHaveLength(1);
});

test("three-read revision: parent pair cannot certify actions while current custom GET is pending", async () => {
  addCustom(); await mount(); await waitFor(() => actionable().length === 1);
  const inventory = hold("/api/models"), selectionRead = hold("/api/selected-models"), ownership = hold("/api/custom-models");
  await act(async () => { refresh(); });
  expect(actionable()).toEqual([]);
  await Promise.all([inventory.started, selectionRead.started, ownership.started]);
  await act(async () => { selectionRead.release(Response.json(selection())); }); expect(actionable()).toEqual([]);
  await act(async () => { inventory.release(Response.json(rows)); }); await current(); expect(actionable()).toEqual([]);
  await act(async () => { ownership.release(Response.json(custom)); }); await waitFor(() => actionable().length === 1);
  expect(requests).toEqual([]);
});

for (const failedPath of ["/api/models", "/api/selected-models"]) {
  test(`a failed half (${failedPath}) keeps the paired observation read-only until Retry`, async () => {
    rows = [row("live")]; await mount(); await waitFor(() => actionable().length === 1);
    const bad = hold(failedPath); await act(async () => { refresh(); }); await bad.started;
    await act(async () => { bad.release(Response.json({ error: "offline" }, { status: 503 })); });
    await waitFor(() => host.querySelector('[role="alert"]') !== null);
    expect(actionable()).toEqual([]); expect(requests).toEqual([]);
    const retry = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry")!;
    await click(retry); await waitFor(() => actionable().length === 1);
  });
}

test("reversed parent and ownership responses cannot restore an older custom stable id", async () => {
  addCustom("old"); await mount(); await waitFor(() => actionable().length === 1);
  const oldRows = structuredClone(rows), oldCustom = structuredClone(custom);
  const staleRows = hold("/api/models"), staleSelection = hold("/api/selected-models"), staleCustom = hold("/api/custom-models");
  await act(async () => { refresh(); }); await Promise.all([staleRows.started, staleSelection.started, staleCustom.started]);
  custom[0]!.id = "replacement"; rows[0]!.customId = "replacement";
  await act(async () => { refresh(); }); await waitFor(() => actionable().length === 1);
  await act(async () => {
    staleCustom.release(Response.json(oldCustom)); staleRows.release(Response.json(oldRows)); staleSelection.release(Response.json(selection()));
  });
  await click(action("vendor/custom-model", "Delete")); await waitFor(() => custom.length === 0 && ids().length === 0);
  expect(requests).toEqual([{ path: "/api/custom-models/replacement", method: "DELETE" }]);
});

test("mismatched current custom ownership never falls back to Hide", async () => {
  addCustom("dto-id"); custom[0]!.id = "different-id";
  await mount(); await current();
  expect(actionable()).toEqual([]); expect(chip("vendor/custom-model").querySelector('button[aria-label="Hide: vendor/custom-model"]')).toBeNull(); expect(requests).toEqual([]);
});

test("provider switch rejects the previous provider's delayed ownership", async () => {
  addCustom("vendor-id"); addCustom("other-id", "other", "other-model");
  const delayed = hold("/api/custom-models"); await mount(); await delayed.started;
  await act(async () => { choose("other"); }); await waitFor(() => actionable().length === 1);
  await act(async () => { delayed.release(Response.json([{ id: "vendor-id", provider: "vendor", modelId: "custom-model" }])); });
  expect(ids()).toEqual(["other-model"]); await click(action("other/other-model", "Delete"));
  await waitFor(() => ids().length === 0);
  expect(requests).toEqual([{ path: "/api/custom-models/other-id", method: "DELETE" }]);
  expect(custom).toEqual([{ id: "vendor-id", provider: "vendor", modelId: "custom-model" }]);
});

test("pending selection rows have no destructive action", async () => {
  rows = [row("pending", { initialSelectionPending: true, disabled: true })]; await mount(); await current();
  expect(ids()).toEqual([]); expect(feedback()).toContain("Finish model selection"); expect(actionable()).toEqual([]); expect(requests).toEqual([]);
});

test("malformed DTO makes the parent unavailable, not an editable fallback inventory", async () => {
  const invalid = hold("/api/models"); await mount(); await invalid.started;
  await act(async () => { invalid.release(Response.json([{ provider: "vendor", id: "bad", disabled: false }])); });
  await waitFor(() => host.querySelector('[role="alert"]') !== null);
  expect(actionable()).toEqual([]);
  expect(host.textContent).toContain("Manage visibility in Models"); expect(requests).toEqual([]);
});

test("rail counts inventory before search/cap and routed selection does not badge native", async () => {
  rows = Array.from({ length: 305 }, (_, i) => row(`model-${String(i).padStart(3, "0")}`));
  rows.push(row("hidden", { disabled: true })); selected = { vendor: ["model-304"] };
  available = { vendor: rows.map(value => value.id) };
  await mount(); await waitFor(() => ids().length === 300);
  const vendorOptions = host.querySelectorAll('[role="option"][title="Vendor"]');
  expect(vendorOptions).toHaveLength(1);
  const rail = vendorOptions[0]!;
  expect(rail.getAttribute("aria-selected")).toBe("true");
  expect(rail.textContent).toContain("305");
  const search = host.querySelector<HTMLInputElement>("input.pws-model-search")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(search, "model-304");
    search.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  expect(ids()).toEqual(["model-304"]); expect(rail.textContent).toContain("305");
  expect(chip("vendor/model-304").textContent).toContain("Selected");
  custom = [{ id: "override", provider: "openai", modelId: "account/model" }];
  rows = [row("account/model", { provider: "openai", namespaced: "account/model", native: true }),
    row("account/model", { provider: "openai", namespaced: "openai/account-model", custom: true, customId: "override" })];
  selected = { openai: ["account/model"] }; await act(async () => { choose("openai"); refresh(); });
  await waitFor(() => ids().length === 2);
  expect(chip("account/model").querySelector(".badge-accent")).toBeNull();
  expect(chip("openai/account-model").querySelector(".badge-accent")).not.toBeNull();
});

for (const moved of [false, true]) {
  test(`focused deletion restores a stable control without stealing focus (moved=${moved})`, async () => {
    addCustom(); rows.push(row("remaining")); let release!: () => void;
    writeGate = new Promise<void>(resolve => { release = resolve; });
    await mount(); await waitFor(() => actionable().length === 2);
    const remove = action("vendor/custom-model", "Delete"); remove.focus(); await click(remove);
    const stable = host.querySelector<HTMLInputElement>("input.pws-model-search")!;
    if (moved) stable.focus();
    await act(async () => { release(); }); await waitFor(() => ids().length === 1);
    if (moved) expect(document.activeElement).toBe(stable);
    else {
      expect(document.activeElement).not.toBe(document.body);
      expect(host.contains(document.activeElement)).toBe(true);
      expect(document.activeElement?.matches('input.pws-model-search, button')).toBe(true);
    }
  });
}

test("custom-only Delete then re-add survives an actual unmount with no tombstone", async () => {
  addCustom(); await mount(); await waitFor(() => actionable().length === 1);
  await click(action("vendor/custom-model", "Delete")); await waitFor(() => ids().length === 0); await current();
  const draft = host.querySelector<HTMLInputElement>('input[aria-label="Add custom model"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(draft, "custom-model");
    draft.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  const add = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Add")!;
  await waitFor(() => !add.disabled); await click(add); await waitFor(() => ids().length === 1);
  expect(requests).toEqual([
    { path: "/api/custom-models/custom-1", method: "DELETE" },
    { path: "/api/custom-models", method: "POST", body: { provider: "vendor", modelId: "custom-model" } },
  ]);
  await act(async () => { root!.unmount(); }); root = undefined;
  await mount(); await waitFor(() => actionable().length === 1);
  expect(ids()).toEqual(["custom-model"]); expect(custom[0]?.id).toBe("readded-id");
});

test("independent hides persist on remount and an external unhide returns through paired refresh", async () => {
  rows = [row("live")]; await mount(); await waitFor(() => actionable().length === 1);
  await click(action("vendor/live", "Hide")); await waitFor(() => ids().length === 0);
  await act(async () => { root!.unmount(); }); root = undefined;
  await mount(); await current(); expect(ids()).toEqual([]);
  rows[0]!.disabled = false; await refreshCurrent(); await waitFor(() => actionable().length === 1);
  expect(ids()).toEqual(["live"]); expect(requests).toEqual([{ path: "/api/model-visibility", method: "PUT", body: { scope: "models", provider: "vendor", targets: [{ id: "live", native: false }], enabled: false } }]);
});

test("one parent endpoint pair serves the entire inventory instead of per-chip requests", async () => {
  rows = Array.from({ length: 25 }, (_, i) => row(`model-${i}`));
  await mount(); await waitFor(() => actionable().length === 25);
  expect(reads["/api/models"]).toBe(1); expect(reads["/api/selected-models"]).toBe(1);
  expect(reads["/api/custom-models"]).toBe(1);
});
