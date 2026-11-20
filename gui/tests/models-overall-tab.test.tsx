import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import { resolveAppHashChange } from "../src/app-routing";
import Models from "../src/pages/Models";

/*
 * The Models page "Overall" tab: every model from every provider in one searchable list, each
 * with an on/off switch. It reads and writes the same state as the per-provider catalog, through
 * the same write queue, so the two tabs can never show different answers for one model.
 */
const globals = ["document", "window", "navigator", "localStorage", "sessionStorage",
  "IS_REACT_ACT_ENVIRONMENT", "fetch", "setInterval", "clearInterval"] as const;
let previous: PropertyDescriptor[];
let win: Window;
let container: HTMLElement;
let root: Root;
let puts: Array<{ scope: string; provider: string; targets: Array<{ id: string; native?: boolean }>; enabled: boolean }>;
let writes: Array<() => void>;
let disabled: Set<string>;
let selected: Record<string, string[]>;
let integrationFailure: boolean;
let modelsFail: boolean;
let ticks: Array<() => void>;
type Row = { provider: string; id: string; namespaced: string; native?: boolean; initialSelectionPending?: boolean };
const catalog: Row[] = [
  { provider: "proxy", id: "alpha", namespaced: "proxy/alpha" },
  { provider: "proxy", id: "beta", namespaced: "proxy/beta" },
  { provider: "other", id: "xray", namespaced: "other/xray" },
  { provider: "other", id: "yankee", namespaced: "other/yankee" },
  { provider: "openai", id: "gpt-5.5", namespaced: "gpt-5.5", native: true },
];
let extraRows: Row[];
const rows = () => [...catalog, ...extraRows].map(row => ({ ...row, disabled: disabled.has(row.namespaced) }));
const providers = [
  { name: "proxy", liveModels: false, models: ["alpha", "beta"] },
  { name: "other", liveModels: false, models: ["xray", "yankee"] },
];

beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key)!);
  win = new Window({ url: "http://localhost/#models/overall" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    // Poll ticks are recorded, never scheduled, so a case can run one on demand.
    setInterval: { configurable: true, value: (tick: () => void) => { ticks.push(tick); return ticks.length; } },
    clearInterval: { configurable: true, value: () => {} },
  });
  puts = []; writes = []; disabled = new Set(["other/xray"]); selected = { other: ["xray"] }; ticks = []; modelsFail = false;
  extraRows = []; integrationFailure = false;
  win.localStorage.setItem("ocx-models-collapsed:v2", "[]");
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/model-visibility") {
      const body = JSON.parse(String(init?.body));
      puts.push(body);
      return new Promise<Response>(resolve => writes.push(() => {
        for (const target of body.targets) {
          const key = target.native ? target.id : body.provider + "/" + target.id;
          if (body.enabled) disabled.delete(key); else disabled.add(key);
          const allow = selected[body.provider];
          if (body.enabled && allow && allow.length > 0 && !allow.includes(target.id)) selected[body.provider] = [...allow, target.id];
        }
        resolve(Response.json({ ok: true, clientIntegrations: integrationFailure ? [{ client: "opencode", ok: false, reason: "disk full" }] : [] }));
      }));
    }
    if (path === "/api/models") return modelsFail ? Response.json({ error: "offline" }, { status: 503 }) : Response.json(rows());
    if (path === "/api/providers") return Response.json(providers);
    if (path === "/api/selected-models") return Response.json({ selected });
    if (path === "/api/provider-context-caps") return Response.json({ caps: {} });
    if (path === "/api/subagent-models") return Response.json({ pickerAvailable: [], pickerOrder: [], pickerOrderMode: null });
    if (path === "/api/combos") return Response.json({ combos: [] });
    if (path === "/api/shadow-call-settings") return Response.json({ enabled: false, model: "" });
    if (path === "/api/v2") return Response.json({ enabled: false, multiAgentMode: "default" });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as never);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  clearClientResourceStoresForTests();
  win.close();
  globals.forEach((key, i) => {
    if (previous[i]) Object.defineProperty(globalThis, key, previous[i]); else Reflect.deleteProperty(globalThis, key);
  });
});

async function mount() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Models apiBase="http://localhost" reportRestart={() => {}} /></LanguageProvider>);
  });
}
async function settle(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  expect(predicate()).toBe(true);
}
const panel = (tab: string) => container.querySelector<HTMLElement>("#models-panel-" + tab)!;
const overallSwitches = () => [...panel("overall").querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
const overall = () => overallSwitches().map(button => [button.getAttribute("aria-label"), button.getAttribute("aria-checked")]);
const overallSwitch = (label: string) => overallSwitches().find(button => button.getAttribute("aria-label") === label)!;
const catalogSwitch = (label: string) => [...panel("catalog").querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
  .find(button => button.getAttribute("aria-label") === label);
const tab = (name: string) => container.querySelector<HTMLButtonElement>("#models-tab-" + name)!;
async function type(value: string) {
  const search = panel("overall").querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(search, value);
    search.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}
const filterButton = (label: string) => [...panel("overall").querySelectorAll<HTMLButtonElement>("button[aria-pressed]")]
  .find(button => button.textContent?.trim() === label)!;

test("the app router keeps #models/overall and the Overall tab opens on it", async () => {
  expect(resolveAppHashChange("models/overall")).toEqual({ page: "models", replaceTo: null });
  await mount();
  expect(tab("overall").textContent).toContain("Overall");
  expect(tab("overall").getAttribute("aria-selected")).toBe("true");
  expect(panel("overall").hidden).toBe(false);
  await settle(() => overallSwitches().length === 5);
  // Catalog order: the same grouping the per-provider catalog renders.
  expect(overall()).toEqual([
    ["gpt-5.5", "true"],
    ["other/xray", "false"], ["other/yankee", "false"],
    ["proxy/alpha", "true"], ["proxy/beta", "true"],
  ]);
  // Back/Forward: the hash drives the tab.
  await act(async () => { win.location.hash = "#models"; win.dispatchEvent(new win.HashChangeEvent("hashchange")); });
  expect(tab("catalog").getAttribute("aria-selected")).toBe("true");
  await act(async () => { win.location.hash = "#models/overall"; win.dispatchEvent(new win.HashChangeEvent("hashchange")); });
  expect(tab("overall").getAttribute("aria-selected")).toBe("true");
});

test("search and the On/Off filter narrow the list", async () => {
  await mount(); await settle(() => overallSwitches().length === 5);
  await type("ya");
  expect(overall()).toEqual([["other/yankee", "false"]]);
  await type("");
  await act(async () => { filterButton("Off").click(); });
  expect(filterButton("Off").getAttribute("aria-pressed")).toBe("true");
  expect(overall().map(([label]) => label)).toEqual(["other/xray", "other/yankee"]);
  await act(async () => { filterButton("On").click(); });
  expect(overall().map(([label]) => label)).toEqual(["gpt-5.5", "proxy/alpha", "proxy/beta"]);
  await type("zzz");
  expect(overallSwitches()).toHaveLength(0);
  expect(panel("overall").textContent).toContain("No models match");
});

test("a switch writes once, flips at once, and the catalog tab shows the same answer", async () => {
  await mount(); await settle(() => overallSwitches().length === 5);
  await act(async () => { overallSwitch("other/xray").click(); });
  expect(overallSwitch("other/xray").getAttribute("aria-checked")).toBe("true");
  expect(puts).toEqual([{ scope: "models", provider: "other", targets: [{ id: "xray", native: false }], enabled: true }]);
  // A second switch while the first write runs joins the same ordered queue.
  await act(async () => { overallSwitch("gpt-5.5").click(); });
  expect(overallSwitch("gpt-5.5").getAttribute("aria-checked")).toBe("false");
  // The catalog tab reads the same optimistic state before anything settles.
  await act(async () => { tab("catalog").click(); });
  await settle(() => catalogSwitch("other/xray") !== undefined);
  expect(catalogSwitch("other/xray")!.getAttribute("aria-checked")).toBe("true");
  expect(catalogSwitch("gpt-5.5")!.getAttribute("aria-checked")).toBe("false");
  await act(async () => { writes.shift()!(); });
  await settle(() => puts.length === 2);
  expect(puts[1]).toEqual({ scope: "models", provider: "openai", targets: [{ id: "gpt-5.5", native: true }], enabled: false });
  await act(async () => { writes.shift()!(); });
  await act(async () => { tab("overall").click(); });
  await settle(() => !overallSwitch("other/xray").disabled && overallSwitch("other/xray").getAttribute("aria-checked") === "true");
  expect(overall()).toEqual([
    ["gpt-5.5", "false"],
    ["other/xray", "true"], ["other/yankee", "false"],
    ["proxy/alpha", "true"], ["proxy/beta", "true"],
  ]);
  expect(selected.other).toEqual(["xray"]);
});

test("a write whose client catalogs failed to refresh warns on the Overall tab", async () => {
  integrationFailure = true;
  await mount(); await settle(() => overallSwitches().length === 5);
  await act(async () => { overallSwitch("proxy/beta").click(); });
  await act(async () => { writes.shift()!(); });
  await settle(() => panel("overall").textContent!.includes("Some client catalogs could not be refreshed"));
  expect(panel("overall").textContent).toContain("opencode");
});

test("rows still waiting on the first model selection cannot be switched", async () => {
  extraRows = [{ provider: "proxy", id: "pending", namespaced: "proxy/pending", initialSelectionPending: true }];
  await mount(); await settle(() => overallSwitches().length === 6);
  expect(overallSwitch("proxy/pending").disabled).toBe(true);
  expect(overallSwitch("proxy/alpha").disabled).toBe(false);
});

// The 10 s catalog poll can land while an Overall write is still in flight. The server has not
// applied the write yet, so that read still says "off"; the switch must keep showing the
// requested "on" until the write settles and the authoritative read confirms it.
test("a poll read that lands during an Overall write does not revert the switch", async () => {
  await mount(); await settle(() => overallSwitches().length === 5);
  await act(async () => { overallSwitch("other/yankee").click(); });
  expect(overallSwitch("other/yankee").getAttribute("aria-checked")).toBe("true");
  expect(puts).toHaveLength(1);
  // Write still held: run every poll tick; the server still reports yankee off.
  await act(async () => { for (const tick of [...ticks]) tick(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(overallSwitch("other/yankee").getAttribute("aria-checked")).toBe("true");
  await act(async () => { writes.shift()!(); });
  // Settled means the queue drained and its authoritative catalog read succeeded: only then does
  // the hook publish "Saved" and drop the optimistic override, so "on" below is the saved state.
  await settle(() => container.textContent!.includes("Saved. Codex shows the change"));
  expect(overallSwitch("other/yankee").getAttribute("aria-checked")).toBe("true");
  expect(overallSwitch("other/yankee").disabled).toBe(false);
  expect(selected.other).toEqual(["xray", "yankee"]);
});

test("a failed background refresh is reported on the Overall tab instead of silently showing the last list", async () => {
  await mount(); await settle(() => overallSwitches().length === 5);
  expect(panel("overall").textContent).not.toContain("Failed to load models");
  modelsFail = true;
  await act(async () => { for (const tick of [...ticks]) tick(); });
  await settle(() => panel("overall").textContent!.includes("Failed to load models"));
  // The last good list stays usable; the notice says it may be out of date.
  expect(overallSwitches()).toHaveLength(5);
});

