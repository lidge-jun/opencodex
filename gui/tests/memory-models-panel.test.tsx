/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import MemoryModelsPanel from "../src/components/MemoryModelsPanel";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let container: HTMLDivElement;
let setting: { extract?: { model: string; reasoningEffort?: string }; consolidation?: { model: string; reasoningEffort?: string } } | null;
let failLoad: boolean;
let failSave: boolean;
let writes: unknown[];
const models = [{ id: "cheap", provider: "gateway", namespaced: "gateway/cheap" }, { id: "brisk", provider: "combo", namespaced: "combo/brisk" }];

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  for (const key of ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? win : win[key] });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  win.localStorage.setItem("ocx-lang", "en");
  setting = null; failLoad = false; failSave = false; writes = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (failSave) return Response.json({ error: "fixture failure" }, { status: 500 });
      setting = body.memoryModels;
    } else if (failLoad) return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ memoryModels: setting });
  } });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined; win.close();
  for (const key of globals) {
    if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
async function render(base = "") {
  if (!root) {
    container = win.document.createElement("div") as unknown as HTMLDivElement;
    win.document.body.appendChild(container);
    root = (await import("react-dom/client")).createRoot(container);
  }
  await act(async () => { root!.render(<StrictMode><LanguageProvider><MemoryModelsPanel apiBase={base} models={models} /></LanguageProvider></StrictMode>); });
  await flush();
}
async function choose(id: string, label: string) {
  await act(async () => { container.querySelector<HTMLButtonElement>("#memory-models-" + id)!.click(); });
  const option = [...win.document.querySelectorAll('[role="option"]')].find(node => node.textContent === label);
  expect(option).toBeDefined();
  await act(async () => { (option as unknown as HTMLButtonElement).click(); });
}
function saveButton() { return [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save")!; }
async function save() { await act(async () => { saveButton().click(); }); }
function notice() { return container.querySelector('[role="note"]'); }
const OFF = "Off \u2014 Codex default";

test("the account notice tracks the half-routed state", async () => {
  await render();
  expect(notice()).toBeNull();
  await choose("extract", "gateway/cheap");
  expect(notice()).not.toBeNull();
  await choose("consolidation", "gateway/cheap");
  expect(notice()).toBeNull();
  await choose("extract", OFF);
  expect(notice()).not.toBeNull();
  await choose("consolidation", OFF);
  expect(notice()).toBeNull();
});

test("saves each phase independently and clears effort with its model", async () => {
  await render();
  expect(saveButton().disabled).toBe(true);
  await choose("extract", "gateway/cheap");
  await choose("extract-effort", "Low");
  await choose("consolidation", "gateway/cheap");
  await save();
  expect(writes.at(-1)).toEqual({
    memoryModels: { extract: { model: "gateway/cheap", reasoningEffort: "low" }, consolidation: { model: "gateway/cheap" } },
  });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Memory settings saved.");
  // The effort picker is armed only while its phase names a model, and clearing the model
  // clears the effort with it, so a phase is either fully routed or absent.
  await choose("consolidation", OFF);
  expect((container.querySelector("#memory-models-consolidation-effort") as HTMLButtonElement)!.disabled).toBe(true);
  await choose("consolidation", "gateway/cheap");
  await choose("consolidation-effort", "Medium");
  await save();
  expect(writes.at(-1)).toEqual({
    memoryModels: { extract: { model: "gateway/cheap", reasoningEffort: "low" }, consolidation: { model: "gateway/cheap", reasoningEffort: "medium" } },
  });
  await choose("extract", OFF);
  await save();
  expect(writes.at(-1)).toEqual({ memoryModels: { consolidation: { model: "gateway/cheap", reasoningEffort: "medium" } } });
  await choose("consolidation", OFF);
  await save();
  expect(writes.at(-1)).toEqual({ memoryModels: null });
});

