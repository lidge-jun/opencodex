/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ManualCompactionPanel from "../src/components/ManualCompactionPanel";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let container: HTMLDivElement;
let setting: { model: string; reasoningEffort?: string } | null;
let failLoad: boolean;
let failSave: boolean;
let writes: unknown[];
const models = [{ id: "cheap", provider: "gateway", namespaced: "gateway/cheap" }, { id: "compact", provider: "combo", namespaced: "combo/compact" }];

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
    if (String(_input).endsWith("/api/combos")) {
      return Response.json({ combos: [{ id: "compact", model: "combo/compact", targets: [{ provider: "gateway", model: "a" }, { provider: "openai-apikey", model: "b" }, { provider: "gateway", model: "c" }] }] });
    }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (failSave) return Response.json({ error: "fixture failure" }, { status: 500 });
      setting = body.manualCompaction;
    } else if (failLoad) return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ manualCompaction: setting });
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
  await act(async () => { root!.render(<StrictMode><LanguageProvider><ManualCompactionPanel apiBase={base} models={models} /></LanguageProvider></StrictMode>); });
  await flush();
}
async function choose(id: string, label: string) {
  await act(async () => { container.querySelector<HTMLButtonElement>(`#manual-compaction-${id}`)!.click(); });
  const option = [...win.document.querySelectorAll('[role="option"]')].find(node => node.textContent === label);
  expect(option).toBeDefined();
  await act(async () => { (option as unknown as HTMLButtonElement).click(); });
}
function saveButton() { return [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Save")!; }
async function save() { await act(async () => { saveButton().click(); }); }

test("saves model and optional effort, reloads, removes effort, and clears override", async () => {
  await render();
  expect(saveButton().disabled).toBe(true);
  await choose("model", "gateway/cheap");
  await choose("effort", "Low");
  await save();
  expect(writes).toEqual([{ manualCompaction: { model: "gateway/cheap", reasoningEffort: "low" } }]);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Compaction settings saved.");
  await render("/reloaded");
  expect(container.querySelector('#manual-compaction-effort')?.textContent).toContain("Low");
  await choose("effort", "Keep request effort");
  await save();
  expect(writes.at(-1)).toEqual({ manualCompaction: { model: "gateway/cheap" } });
  await choose("model", "Use conversation model");
  await save();
  expect(writes.at(-1)).toEqual({ manualCompaction: null });
  expect(container.querySelector<HTMLButtonElement>('#manual-compaction-effort')!.disabled).toBe(true);
});

test("failed save retains the draft and allows retry", async () => {
  await render();
  await choose("model", "gateway/cheap");
  failSave = true;
  await save();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  expect(container.querySelector('#manual-compaction-model')?.textContent).toContain("gateway/cheap");
  expect(saveButton().disabled).toBe(false);
  expect(setting).toBeNull();
  failSave = false;
  await save();
  expect(setting).toEqual({ model: "gateway/cheap" });
});

test("failed load disables editing and retry recovers", async () => {
  failLoad = true;
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  expect(container.querySelector<HTMLButtonElement>('#manual-compaction-model')!.disabled).toBe(true);
  failLoad = false;
  await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Retry")!.click(); });
  expect(container.querySelector<HTMLButtonElement>('#manual-compaction-model')!.disabled).toBe(false);
});

test("retains a saved model missing from the current catalog", async () => {
  setting = { model: "gateway/retired", reasoningEffort: "high" };
  await render();
  expect(container.querySelector('#manual-compaction-model')?.textContent).toContain("gateway/retired");
  expect(saveButton().disabled).toBe(true);
});

test("discloses that the selected provider receives the full conversation", async () => {
  await render();
  expect(container.textContent).toContain("sends the entire conversation to the selected model's provider");
  expect(container.querySelector('[role="note"]')).toBeNull();
  await choose("model", "gateway/cheap");
  expect(container.querySelector('[role="note"]')?.textContent).toContain("sends the full conversation contents to gateway for summarization");
  await choose("model", "combo/compact");
  expect(container.querySelector('[role="note"]')?.textContent).toContain("every target of combo combo/compact (gateway, openai-apikey), including failover targets");
  await choose("model", "Use conversation model");
  expect(container.querySelector('[role="note"]')).toBeNull();
});
