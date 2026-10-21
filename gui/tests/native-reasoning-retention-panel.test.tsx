/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import NativeReasoningRetentionPanel from "../src/components/NativeReasoningRetentionPanel";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const MODEL_LABEL = "Keep encrypted reasoning when switching models";
const ACCOUNT_LABEL = "Keep encrypted reasoning when switching accounts (experimental)";
let previous: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let container: HTMLDivElement;
let setting: unknown;
let failLoad: boolean;
let failSave: boolean;
let writes: unknown[];
let urls: string[];

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  for (const key of ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? win : win[key] });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  win.localStorage.setItem("ocx-lang", "en");
  setting = { modelSwitch: false, accountSwitch: false };
  failLoad = false; failSave = false; writes = []; urls = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (input: unknown, init?: RequestInit) => {
    urls.push(String(input));
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (failSave) return Response.json({ error: "fixture failure" }, { status: 500 });
      setting = body ?? { modelSwitch: false, accountSwitch: false };
    } else if (failLoad) return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json(setting);
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
  await act(async () => { root!.render(<StrictMode><LanguageProvider><NativeReasoningRetentionPanel apiBase={base} /></LanguageProvider></StrictMode>); });
  await flush();
}
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(value => value.textContent === label || value.getAttribute("aria-label") === label)!;
}
async function click(label: string) { await act(async () => { button(label).click(); }); }
function enabled(label: string) { return button(label).getAttribute("aria-pressed") === "true"; }

test("loads conservative defaults and saves model/account choices independently through the dedicated route", async () => {
  await render("/proxy");
  expect(enabled(MODEL_LABEL)).toBe(false);
  expect(enabled(ACCOUNT_LABEL)).toBe(false);
  expect(button("Save").disabled).toBe(true);
  expect(button("Restore defaults").disabled).toBe(true);
  expect(container.textContent).toContain("official ChatGPT backend");
  expect(container.textContent).toContain("does not prove reasoning reuse");
  await click(MODEL_LABEL); await click("Save");
  expect(writes).toEqual([{ modelSwitch: true, accountSwitch: false }]);
  expect(button("Save").disabled).toBe(true);
  await click(MODEL_LABEL); await click(ACCOUNT_LABEL); await click("Save");
  expect(writes.at(-1)).toEqual({ modelSwitch: false, accountSwitch: true });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Native reasoning settings saved.");
  expect(urls.every(value => value === "/proxy/api/native-reasoning-retention")).toBe(true);
});

test("reloads saved choices and resetting removes the block with a null payload", async () => {
  setting = { modelSwitch: true, accountSwitch: true };
  await render();
  expect(enabled(MODEL_LABEL)).toBe(true);
  expect(enabled(ACCOUNT_LABEL)).toBe(true);
  expect(button("Save").disabled).toBe(true);
  await click("Restore defaults");
  expect(writes).toEqual([null]);
  expect(enabled(MODEL_LABEL)).toBe(false);
  expect(enabled(ACCOUNT_LABEL)).toBe(false);
  expect(button("Restore defaults").disabled).toBe(true);
});

test("load errors disable writes and retry reloads authoritative settings", async () => {
  failLoad = true; await render();
  expect(button(MODEL_LABEL).disabled).toBe(true);
  expect(button(ACCOUNT_LABEL).disabled).toBe(true);
  expect(button("Save").disabled).toBe(true);
  expect(button("Restore defaults").disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  setting = { modelSwitch: false, accountSwitch: true }; failLoad = false;
  await click("Retry");
  expect(enabled(ACCOUNT_LABEL)).toBe(true);
  expect(button(MODEL_LABEL).disabled).toBe(false);
  expect(writes).toEqual([]);
});

test.each([null, [], {}, { modelSwitch: true }, { modelSwitch: "true", accountSwitch: false }].map(value => [value]))(
  "missing or malformed read settings never enable writes: %j", async value => {
    setting = value; await render();
    expect(button(MODEL_LABEL).disabled).toBe(true);
    expect(button(ACCOUNT_LABEL).disabled).toBe(true);
    expect(button("Save").disabled).toBe(true);
    expect(button("Restore defaults").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
    expect(writes).toEqual([]);
  },
);

test("save failures retain the draft for retry and do not claim success", async () => {
  await render(); await click(MODEL_LABEL);
  failSave = true; await click("Save");
  expect(enabled(MODEL_LABEL)).toBe(true);
  expect(button("Save").disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  expect(container.querySelector('[role="status"]')).toBeNull();
  failSave = false; await click("Save");
  expect(button("Save").disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("a pending write disables all controls and duplicate clicks send only one update", async () => {
  await render(); await click(ACCOUNT_LABEL);
  const pending = Promise.withResolvers<Response>();
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    writes.push(JSON.parse(String(init?.body))); return pending.promise;
  }) as typeof fetch;
  await act(async () => { button("Save").click(); button("Save").click(); });
  expect(writes).toEqual([{ modelSwitch: false, accountSwitch: true }]);
  for (const label of [MODEL_LABEL, ACCOUNT_LABEL, "Save", "Restore defaults"]) expect(button(label).disabled).toBe(true);
  await act(async () => { pending.resolve(Response.json({ modelSwitch: false, accountSwitch: true })); });
  expect(button(ACCOUNT_LABEL).disabled).toBe(false);
  expect(button("Save").disabled).toBe(true);
});

test("a malformed successful save response keeps the draft and reports failure", async () => {
  await render(); await click(MODEL_LABEL);
  globalThis.fetch = (async () => Response.json({ modelSwitch: false })) as typeof fetch;
  await click("Save");
  expect(enabled(MODEL_LABEL)).toBe(true);
  expect(button("Save").disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
});

test("a late response from the previous API origin cannot replace current choices", async () => {
  const pending = Promise.withResolvers<Response>();
  globalThis.fetch = (async (input: unknown) => String(input).startsWith("/old/")
    ? pending.promise : Response.json({ modelSwitch: true, accountSwitch: false })) as typeof fetch;
  await render("/old");
  expect(button("Save").disabled).toBe(true);
  await render("/new");
  expect(enabled(MODEL_LABEL)).toBe(true);
  await act(async () => { pending.resolve(Response.json({ modelSwitch: false, accountSwitch: true })); });
  expect(enabled(MODEL_LABEL)).toBe(true);
  expect(enabled(ACCOUNT_LABEL)).toBe(false);
});
