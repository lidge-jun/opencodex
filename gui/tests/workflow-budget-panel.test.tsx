/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import WorkflowBudgetPanel from "../src/components/WorkflowBudgetPanel";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
const defaults = { maxConcurrentChildren: 8, maxPhysicalSends: 256, maxDistinctChildren: 64 };
const bounds = {
  maxConcurrentChildren: { min: 2, max: 64 },
  maxPhysicalSends: { min: 1, max: 10_000 },
  maxDistinctChildren: { min: 1, max: 1_024 },
};
const PARALLEL = "Parallel turns";
const SENDS = "Model requests per window";
let previous: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let container: HTMLDivElement;
let setting: Record<string, number>;
let failLoad: boolean;
let failSave: boolean;
let writes: unknown[];
let urls: string[];

const payload = () => ({ ...setting, interactiveReserve: 1, windowMs: 600_000, defaults, bounds });

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  for (const key of ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? win : win[key] });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  win.localStorage.setItem("ocx-lang", "en");
  setting = { ...defaults };
  failLoad = false; failSave = false; writes = []; urls = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (input: unknown, init?: RequestInit) => {
    urls.push(String(input));
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, number> | null;
      writes.push(body);
      if (failSave) return Response.json({ error: "fixture failure" }, { status: 500 });
      setting = body === null ? { ...defaults } : { ...setting, ...body };
    } else if (failLoad) return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json(payload());
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
  container = win.document.createElement("div") as unknown as HTMLDivElement;
  win.document.body.appendChild(container);
  root = (await import("react-dom/client")).createRoot(container);
  await act(async () => { root!.render(<StrictMode><LanguageProvider><WorkflowBudgetPanel apiBase={base} /></LanguageProvider></StrictMode>); });
  await flush();
}
function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(value => value.textContent === label || value.getAttribute("aria-label") === label)!;
}
const input = (label: string) => container.querySelector<HTMLInputElement>('input[aria-label="' + label + '"]')!;
async function click(label: string) { await act(async () => { button(label).click(); }); }
async function enter(label: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input(label), value);
    input(label).dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

test("shows the effective ceilings and saves all three through the dedicated route", async () => {
  await render("/proxy");
  expect(input(PARALLEL).value).toBe("8");
  expect(input(SENDS).value).toBe("256");
  expect(container.textContent).toContain("rolling 10-minute window");
  expect(container.textContent).toContain("Default 8, allowed 2–64.");
  expect(button("Save").disabled).toBe(true);
  expect(button("Restore defaults").disabled).toBe(true);
  await click("Increase " + PARALLEL); await click("Increase " + PARALLEL);
  await enter(SENDS, "1024");
  await click("Save");
  expect(writes).toEqual([{ maxConcurrentChildren: 10, maxPhysicalSends: 1_024, maxDistinctChildren: 64 }]);
  expect(input(PARALLEL).value).toBe("10");
  expect(button("Save").disabled).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Workflow limits saved.");
  expect(urls.every(value => value === "/proxy/api/workflow-budget/settings")).toBe(true);
});

test("saving the defaults and restoring both write null so the install keeps following built-in ceilings", async () => {
  setting = { ...defaults, maxConcurrentChildren: 12 };
  await render();
  expect(input(PARALLEL).value).toBe("12");
  await enter(PARALLEL, "8");
  await click("Save");
  expect(writes).toEqual([null]);
  expect(button("Restore defaults").disabled).toBe(true);
  await click("Increase " + PARALLEL); await click("Save");
  expect(writes.at(-1)).toEqual({ ...defaults, maxConcurrentChildren: 9 });
  await click("Restore defaults");
  expect(writes.at(-1)).toBeNull();
  expect(input(PARALLEL).value).toBe("8");
  expect(button("Restore defaults").disabled).toBe(true);
});

test("an out-of-range draft names the allowed range and blocks saving", async () => {
  await render();
  await enter(PARALLEL, "1");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a whole number from 2 to 64.");
  expect(input(PARALLEL).getAttribute("aria-invalid")).toBe("true");
  expect(button("Save").disabled).toBe(true);
  await enter(PARALLEL, "65");
  expect(button("Save").disabled).toBe(true);
  await click("Decrease " + PARALLEL);
  expect(input(PARALLEL).value).toBe("64");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button("Save").disabled).toBe(false);
  expect(writes).toEqual([]);
});

test("load errors disable every control and retry reloads", async () => {
  failLoad = true; await render();
  expect(button("Save").disabled).toBe(true);
  expect(button("Restore defaults").disabled).toBe(true);
  expect(button("Increase " + PARALLEL).disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load workflow limits.");
  failLoad = false; setting = { ...defaults, maxPhysicalSends: 512 };
  await click("Retry");
  expect(input(SENDS).value).toBe("512");
  expect(button("Increase " + PARALLEL).disabled).toBe(false);
});

test("a failed save keeps the draft and does not claim success", async () => {
  await render();
  await click("Increase " + PARALLEL);
  failSave = true; await click("Save");
  expect(input(PARALLEL).value).toBe("9");
  expect(button("Save").disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save workflow limits.");
  expect(container.querySelector('[role="status"]')).toBeNull();
});
