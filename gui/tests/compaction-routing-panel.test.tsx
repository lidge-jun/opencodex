/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CompactionRoutingPanel from "../src/components/CompactionRoutingPanel";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let container: HTMLDivElement;
let setting: { model: string; reasoningEffort?: string; triggers?: string[] } | null;
let failLoad: boolean;
let failSave: boolean;
let combosUnavailable: boolean;
let writes: unknown[];
const models = [{ id: "cheap", provider: "gateway", namespaced: "gateway/cheap" }, { id: "compact", provider: "combo", namespaced: "combo/compact" }];
// A combo reached through an alias carries no `combo/` prefix, which is the shape #5216 was
// filed about: the panel has to learn what the selection resolves to, not read its name.
const ALIASED_COMBO = { id: "fast", model: "quickpick", alias: "quickpick", targets: [{ provider: "xai", model: "a" }, { provider: "gateway", model: "b" }] };

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  for (const key of ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? win : win[key] });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  win.localStorage.setItem("ocx-lang", "en");
  setting = null; failLoad = false; failSave = false; combosUnavailable = false; writes = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (_input: unknown, init?: RequestInit) => {
    if (String(_input).endsWith("/api/combos")) {
      if (combosUnavailable) return Response.json({ error: "unavailable" }, { status: 503 });
      return Response.json({ combos: [
        { id: "compact", model: "combo/compact", targets: [{ provider: "gateway", model: "a" }, { provider: "openai-apikey", model: "b" }, { provider: "gateway", model: "c" }] },
        ALIASED_COMBO,
      ] });
    }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (failSave) return Response.json({ error: "fixture failure" }, { status: 500 });
      setting = body.compactionRouting;
    } else if (failLoad) return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ compactionRouting: setting });
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
  await act(async () => { root!.render(<StrictMode><LanguageProvider><CompactionRoutingPanel apiBase={base} models={models} /></LanguageProvider></StrictMode>); });
  await flush();
}
async function choose(id: string, label: string) {
  await act(async () => { container.querySelector<HTMLButtonElement>(`#compaction-routing-${id}`)!.click(); });
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
  expect(writes).toEqual([{ compactionRouting: { model: "gateway/cheap", reasoningEffort: "low" } }]);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Compaction settings saved.");
  await render("/reloaded");
  expect(container.querySelector('#compaction-routing-effort')?.textContent).toContain("Low");
  await choose("effort", "Keep request effort");
  await save();
  expect(writes.at(-1)).toEqual({ compactionRouting: { model: "gateway/cheap" } });
  await choose("model", "Use conversation model");
  await save();
  expect(writes.at(-1)).toEqual({ compactionRouting: null });
  expect(container.querySelector<HTMLButtonElement>('#compaction-routing-effort')!.disabled).toBe(true);
});

test("the trigger selection round-trips and discloses automatic compaction", async () => {
  await render();
  await choose("model", "gateway/cheap");
  expect(container.querySelector('#compaction-routing-triggers')?.textContent).toContain("Manual /compact only");
  expect(container.textContent).not.toContain("Automatic compaction runs on its own");
  await choose("triggers", "Manual and automatic");
  await save();
  expect(writes.at(-1)).toEqual({ compactionRouting: { model: "gateway/cheap", triggers: ["manual", "auto"] } });
  expect(container.textContent).toContain("Automatic compaction runs on its own");
  await render("/reloaded");
  expect(container.querySelector('#compaction-routing-triggers')?.textContent).toContain("Manual and automatic");
  await choose("triggers", "Automatic only");
  await save();
  expect(writes.at(-1)).toEqual({ compactionRouting: { model: "gateway/cheap", triggers: ["auto"] } });
  // Manual-only is sent as an omitted `triggers`, so the default save keeps the payload the
  // manual-only override already used.
  await choose("triggers", "Manual /compact only");
  await save();
  expect(writes.at(-1)).toEqual({ compactionRouting: { model: "gateway/cheap" } });
  await choose("model", "Use conversation model");
  expect(container.querySelector<HTMLButtonElement>('#compaction-routing-triggers')!.disabled).toBe(true);
});

test("failed save retains the draft and allows retry", async () => {
  await render();
  await choose("model", "gateway/cheap");
  failSave = true;
  await save();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  expect(container.querySelector('#compaction-routing-model')?.textContent).toContain("gateway/cheap");
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
  expect(container.querySelector<HTMLButtonElement>('#compaction-routing-model')!.disabled).toBe(true);
  failLoad = false;
  await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Retry")!.click(); });
  expect(container.querySelector<HTMLButtonElement>('#compaction-routing-model')!.disabled).toBe(false);
});

test("retains a saved model missing from the current catalog", async () => {
  setting = { model: "gateway/retired", reasoningEffort: "high" };
  await render();
  expect(container.querySelector('#compaction-routing-model')?.textContent).toContain("gateway/retired");
  expect(saveButton().disabled).toBe(true);
});

test("discloses that the selected provider receives the full conversation", async () => {
  await render();
  expect(container.textContent).toContain("sends the entire conversation to the selected model's provider");
  expect(container.querySelector('[role="note"]')).toBeNull();
  await choose("model", "gateway/cheap");
  expect(container.querySelector('[role="note"]')?.textContent).toContain("sends the full conversation contents to gateway for summarization");
  await choose("model", "combo/compact");
  const comboNote = container.querySelector('[role="note"]')?.textContent ?? "";
  expect(comboNote).toContain("combo combo/compact");
  expect(comboNote).toContain("(gateway, openai-apikey)");
  // The runtime tries one target at a time and stops at the first answer; the panel used to
  // promise fan-out to every target, which an operator would budget latency and cost for.
  expect(comboNote).toContain("in order and uses the first that answers");
  expect(comboNote).not.toContain("every target");
  await choose("model", "Use conversation model");
  expect(container.querySelector('[role="note"]')).toBeNull();
});

test("names the targets of a combo reached through an alias", async () => {
  setting = { model: ALIASED_COMBO.model };
  await render();
  const note = container.querySelector('[role="note"]')?.textContent ?? "";
  // Before #5216 this selection had no `combo/` prefix, so the panel called it a provider and
  // named none of its targets.
  expect(note).toContain(`combo ${ALIASED_COMBO.model}`);
  expect(note).toContain("(xai, gateway)");
  expect(note).not.toContain("its configured target providers");
  expect(note).toContain("in order and uses the first that answers");
});

test("still calls a prefixed combo a combo when the combo list is unavailable", async () => {
  // The combo list is the only source of target names, and losing it must not downgrade the
  // disclosure to "the provider named combo receives your conversation".
  combosUnavailable = true;
  setting = { model: "combo/compact" };
  await render();
  const note = container.querySelector('[role="note"]')?.textContent ?? "";
  expect(note).toContain("combo combo/compact");
  expect(note).toContain("its configured target providers");
});

test("an alias that shadows an Object member is not read as a target list", async () => {
  // A combo id is free-form, so `constructor` is a legal alias. Reading it off a plain object
  // would hand the renderer a function to join.
  setting = { model: "constructor" };
  await render();
  const note = container.querySelector('[role="note"]')?.textContent ?? "";
  expect(note).toContain("sends the full conversation contents to constructor for summarization");
});
