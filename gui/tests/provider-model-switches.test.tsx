import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import ProviderWorkspaceShell from "../src/components/provider-workspace/ProviderWorkspaceShell";
import ProviderModels from "../src/components/provider-workspace/ProviderModels";
import { LanguageProvider } from "../src/i18n/provider";
import type { ModelRow } from "../src/pages/models-shared";
import type { WorkspaceProvider } from "../src/provider-workspace/catalog";
import { acceptActionDialog, actionDialogOpen, dismissActionDialog } from "./helpers/action-dialog";

/*
 * The provider Models tab turns models on and off itself. These cases read the screen the way a
 * person does: which rows are listed, which switches are on, what was sent, and what the list
 * says after the authoritative re-read. The fake server applies the same two persisted filters
 * as PUT /api/model-visibility: a provider allowlist and the shared disabled list.
 */
const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement",
  "IS_REACT_ACT_ENVIRONMENT", "confirm", "alert", "prompt"] as const;
const originalFetch = globalThis.fetch;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let root: Root | undefined;
let host: HTMLElement;
let rows: ModelRow[];
let custom: Array<{ id: string; provider: string; modelId: string }>;
let selected: Record<string, string[]>;
let requests: Array<{ path: string; method: string; body?: unknown; signal?: AbortSignal | null }>;
let reads: Record<string, number>;
let writeGate: Promise<void> | undefined;
let putFailure: "none" | "status" | "integration";
let choose: (name: string) => void = () => { throw new Error("not mounted"); };
const providers: Record<string, WorkspaceProvider> = {
  vendor: { adapter: "openai-chat", baseUrl: "https://vendor.invalid/v1", hasApiKey: true },
  other: { adapter: "openai-chat", baseUrl: "https://other.invalid/v1", hasApiKey: true },
};
const row = (id: string, extra: Partial<ModelRow> = {}): ModelRow => ({ provider: "vendor", id, namespaced: "vendor/" + id, disabled: false, ...extra });

async function api(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input), "http://localhost").pathname;
  const method = init?.method ?? "GET";
  if (method === "GET") {
    reads[path] = (reads[path] ?? 0) + 1;
    if (path === "/api/models") return Response.json(rows);
    if (path === "/api/selected-models") return Response.json({ selected, available: {}, liveModelCounts: {} });
    if (path === "/api/custom-models") return Response.json(custom);
    if (path === "/api/provider-quotas") return Response.json({ reports: [] });
    if (path === "/api/usage") return Response.json({ providers: [], models: [] });
    throw new Error("Unexpected read: " + path);
  }
  const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ path, method, ...(body === undefined ? {} : { body }), signal: init?.signal });
  if (writeGate) await writeGate;
  if (method === "PUT" && path === "/api/model-visibility") {
    if (putFailure === "status") return Response.json({ error: "nope" }, { status: 500 });
    const target = body as { provider: string; targets: Array<{ id: string; native?: boolean }>; enabled: boolean };
    for (const entry of target.targets) {
      const found = rows.find(value => value.provider === target.provider && value.id === entry.id);
      if (!found) return Response.json({ error: "invalid target" }, { status: 400 });
      found.disabled = !target.enabled;
      const allow = selected[target.provider];
      if (target.enabled && allow && allow.length > 0 && !allow.includes(entry.id)) selected[target.provider] = [...allow, entry.id];
    }
    return Response.json({ ok: true, clientIntegrations: putFailure === "integration"
      ? [{ client: "opencode", ok: false, reason: "disk full" }] : [] });
  }
  if (method === "DELETE") {
    const id = decodeURIComponent(path.split("/").at(-1)!);
    custom = custom.filter(value => value.id !== id);
    rows = rows.filter(value => value.customId !== id);
    return Response.json({ ok: true });
  }
  throw new Error("Unexpected write: " + method + " " + path);
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({ document: win.document, window: win, navigator: win.navigator,
    localStorage: win.localStorage, sessionStorage: win.sessionStorage, HTMLElement: win.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  for (const name of ["confirm", "alert", "prompt"] as const) {
    const trap = () => { throw new Error(name + "() must not be reached"); };
    Object.defineProperty(globalThis, name, { configurable: true, value: trap });
    Object.defineProperty(win, name, { configurable: true, value: trap });
  }
  rows = []; custom = []; selected = {}; requests = []; reads = {}; writeGate = undefined; putFailure = "none";
  globalThis.fetch = api as typeof fetch;
  host = document.createElement("div"); document.body.append(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined; globalThis.fetch = originalFetch;
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

function observed(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new win.MutationObserver(() => {
      if (!predicate()) return;
      observer.disconnect(); clearTimeout(timeout); resolve();
    });
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("DOM condition not reached: " + host.textContent)); }, 3000);
    observer.observe(host as never, { childList: true, subtree: true, attributes: true, characterData: true });
  });
}
async function waitFor(predicate: () => boolean) {
  await act(async () => {});
  await observed(predicate);
  await act(async () => {});
}
const switches = () => [...host.querySelectorAll<HTMLButtonElement>('.pws-model-chip button[role="switch"]')];
const switchFor = (label: string) => {
  const found = switches().filter(button => button.getAttribute("aria-label") === label);
  expect(found).toHaveLength(1);
  return found[0]!;
};
const state = () => switches().map(button => [button.getAttribute("aria-label"), button.getAttribute("aria-checked")]);
const enabledSwitches = () => switches().filter(button => !button.disabled);
const feedback = () => [...host.querySelectorAll('[role="alert"], [role="status"]')].map(node => node.textContent).join(" ");
const ids = () => [...host.querySelectorAll(".pws-model-id")].map(node => node.textContent);
const puts = () => requests.filter(request => request.path === "/api/model-visibility").map(request => request.body);

async function mount(name = "vendor") {
  function Harness() {
    const [provider, setProvider] = useState(name);
    useEffect(() => { choose = setProvider; }, []);
    return <ProviderWorkspaceShell providers={providers} apiBase="http://localhost:10100" defaultProvider="vendor"
      selectedName={provider} onSelect={value => setProvider(value ?? "vendor")} onAddProvider={() => {}}
      detail={(item, data) => <section>
        <ProviderModels key={item.name} item={item} {...data} apiBase="http://localhost:10100" onOpenModels={() => {}} />
      </section>} />;
  }
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root = createRoot(host); root.render(<LanguageProvider><Harness /></LanguageProvider>); });
}
function hold() {
  let release!: () => void;
  writeGate = new Promise<void>(resolve => { release = resolve; });
  return () => { writeGate = undefined; release(); };
}

test("every provider model is listed with a switch that follows the allowlist and the disabled list", async () => {
  rows = [row("listed"), row("turned-off", { disabled: true }), row("not-allowed")];
  selected = { vendor: ["listed", "turned-off"] };
  await mount(); await waitFor(() => enabledSwitches().length === 3);
  expect(ids()).toEqual(["listed", "turned-off", "not-allowed"]);
  expect(state()).toEqual([
    ["vendor/listed", "true"], ["vendor/turned-off", "false"], ["vendor/not-allowed", "false"],
  ]);
  expect(host.textContent).toContain("1/3 visible");
  // The one-way Hide button is gone; the switch is the only visibility control.
  expect(host.querySelector('button[aria-label^="Hide: "]')).toBeNull();
});

test("a click turns the model on at once, writes once, and stays on after the re-read", async () => {
  rows = [row("listed"), row("not-allowed")];
  selected = { vendor: ["listed"] };
  await mount(); await waitFor(() => enabledSwitches().length === 2);
  const readsBefore = reads["/api/models"] ?? 0;
  const release = hold();
  await act(async () => { switchFor("vendor/not-allowed").click(); });
  expect(switchFor("vendor/not-allowed").getAttribute("aria-checked")).toBe("true");
  expect(puts()).toEqual([{ scope: "models", provider: "vendor", targets: [{ id: "not-allowed", native: false }], enabled: true }]);
  // One write at a time on this page: nothing else can be accepted until it settles.
  expect(enabledSwitches()).toEqual([]);
  await act(async () => { switchFor("vendor/listed").click(); });
  expect(puts()).toHaveLength(1);
  await act(async () => { release(); });
  await waitFor(() => enabledSwitches().length === 2);
  expect(state()).toEqual([["vendor/listed", "true"], ["vendor/not-allowed", "true"]]);
  expect(selected.vendor).toEqual(["listed", "not-allowed"]);
  expect(reads["/api/models"]).toBeGreaterThan(readsBefore);
  expect(host.textContent).toContain("2/2 visible");
});

test("a refused write reports the failure and the switch returns to the saved state", async () => {
  rows = [row("off", { disabled: true })];
  putFailure = "status";
  await mount(); await waitFor(() => enabledSwitches().length === 1);
  await act(async () => { switchFor("vendor/off").click(); });
  await waitFor(() => feedback().includes("Save failed") && enabledSwitches().length === 1);
  expect(switchFor("vendor/off").getAttribute("aria-checked")).toBe("false");
});

test("a saved write whose client catalogs failed to refresh says so", async () => {
  rows = [row("on")];
  putFailure = "integration";
  await mount(); await waitFor(() => enabledSwitches().length === 1);
  await act(async () => { switchFor("vendor/on").click(); });
  await waitFor(() => host.textContent!.includes("Some client catalogs could not be refreshed") && enabledSwitches().length === 1);
  expect(host.textContent).toContain("opencode");
  expect(switchFor("vendor/on").getAttribute("aria-checked")).toBe("false");
});

test("Delete and a switch never run together", async () => {
  custom = [{ id: "custom-1", provider: "vendor", modelId: "custom-model" }];
  rows = [row("custom-model", { custom: true, customId: "custom-1" }), row("plain")];
  await mount(); await waitFor(() => enabledSwitches().length === 2);
  const deleteButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Delete: vendor/custom-model"]')!;
  await waitFor(() => !deleteButton().disabled);
  // A pending toggle blocks Delete.
  const release = hold();
  await act(async () => { switchFor("vendor/plain").click(); });
  expect(deleteButton().disabled).toBe(true);
  await act(async () => { deleteButton().click(); });
  expect(actionDialogOpen(win.document as unknown as Document)).toBe(false);
  await act(async () => { release(); });
  await waitFor(() => enabledSwitches().length === 2 && !deleteButton().disabled);
  // An open Delete dialog blocks the switches.
  await act(async () => { deleteButton().click(); });
  expect(actionDialogOpen(win.document as unknown as Document)).toBe(true);
  expect(enabledSwitches()).toEqual([]);
  await act(async () => { switchFor("vendor/plain").click(); });
  expect(puts()).toHaveLength(1);
  await act(async () => { dismissActionDialog(win.document as unknown as Document); await Promise.resolve(); });
  await waitFor(() => enabledSwitches().length === 2);
  expect(requests.filter(request => request.method === "DELETE")).toEqual([]);
});

test("leaving the provider while a write runs neither cancels nor forgets it", async () => {
  rows = [row("off", { disabled: true }), row("elsewhere", { provider: "other", namespaced: "other/elsewhere" })];
  await mount(); await waitFor(() => enabledSwitches().length === 1);
  const release = hold();
  await act(async () => { switchFor("vendor/off").click(); });
  await act(async () => { choose("other"); });
  await waitFor(() => ids().join() === "elsewhere");
  expect(requests[0]?.signal?.aborted ?? false).toBe(false);
  await act(async () => { choose("vendor"); });
  await waitFor(() => switches().length === 1);
  expect(switchFor("vendor/off").getAttribute("aria-checked")).toBe("true");
  await act(async () => { release(); });
  await waitFor(() => enabledSwitches().length === 1);
  expect(switchFor("vendor/off").getAttribute("aria-checked")).toBe("true");
  expect(rows[0]?.disabled).toBe(false);
});

test("an open Delete dialog closes when its provider is left, and Delete works again on return", async () => {
  custom = [{ id: "custom-1", provider: "vendor", modelId: "custom-model" }];
  rows = [row("custom-model", { custom: true, customId: "custom-1" }), row("elsewhere", { provider: "other", namespaced: "other/elsewhere" })];
  await mount();
  const deleteButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Delete: vendor/custom-model"]');
  await waitFor(() => deleteButton()?.disabled === false);
  await act(async () => { deleteButton()!.click(); });
  expect(actionDialogOpen(win.document as unknown as Document)).toBe(true);
  await act(async () => { choose("other"); });
  await waitFor(() => ids().join() === "elsewhere");
  expect(actionDialogOpen(win.document as unknown as Document)).toBe(false);
  await act(async () => { choose("vendor"); });
  await waitFor(() => deleteButton()?.disabled === false);
  await act(async () => { deleteButton()!.click(); });
  await act(async () => { acceptActionDialog(win.document as unknown as Document); await Promise.resolve(); });
  await waitFor(() => !ids().includes("custom-model"));
  expect(requests.filter(request => request.method === "DELETE").map(request => request.path)).toEqual(["/api/custom-models/custom-1"]);
});

test("rows still waiting on the first model selection cannot be switched", async () => {
  rows = [row("pending", { initialSelectionPending: true, disabled: true })];
  await mount(); await waitFor(() => switches().length === 1);
  expect(switchFor("vendor/pending").disabled).toBe(true);
});

