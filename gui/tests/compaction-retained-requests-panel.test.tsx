/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CompactionRetainedRequestsPanel from "../src/components/CompactionRetainedRequestsPanel";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let container: HTMLDivElement;
let stored: boolean;
let failLoad: boolean;
let failSave: boolean;
let writes: unknown[];

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  for (const key of ["document", "window", "navigator", "localStorage", "sessionStorage", "HTMLElement"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? win : win[key] });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  win.localStorage.setItem("ocx-lang", "en");
  stored = false; failLoad = false; failSave = false; writes = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (failSave) return Response.json({ error: "fixture failure" }, { status: 500 });
      stored = body.compactionDropRetainedRequests === true;
    } else if (failLoad) return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ compactionDropRetainedRequests: stored });
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
async function render() {
  container = win.document.createElement("div") as unknown as HTMLDivElement;
  win.document.body.appendChild(container);
  root = (await import("react-dom/client")).createRoot(container);
  await act(async () => { root!.render(<StrictMode><LanguageProvider><CompactionRetainedRequestsPanel apiBase="" /></LanguageProvider></StrictMode>); });
  await flush();
}
const toggle = () => container.querySelector("button.toggle") as HTMLButtonElement;
async function click(button: HTMLButtonElement) {
  await act(async () => { button.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent); });
  await flush();
}

test("renders the stored state as an accessible switch and writes only its own field", async () => {
  await render();
  expect(container.textContent).toContain("Drop retained requests after compaction");
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(toggle().disabled).toBe(false);
  await click(toggle());
  expect(writes).toEqual([{ compactionDropRetainedRequests: true }]);
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector("[role=status]")?.textContent).toBe("Retained requests are now left out after compaction.");
  await click(toggle());
  expect(writes).toEqual([{ compactionDropRetainedRequests: true }, { compactionDropRetainedRequests: false }]);
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
});

test("a failed save reverts the switch and reports the error", async () => {
  failSave = true;
  await render();
  await click(toggle());
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Could not save. The previous setting is still active.");
});

test("a failed load keeps the switch disabled and offers a retry", async () => {
  failLoad = true;
  await render();
  expect(toggle().disabled).toBe(true);
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Could not load this setting.");
  failLoad = false;
  await click(container.querySelector("[role=alert] button") as HTMLButtonElement);
  expect(toggle().disabled).toBe(false);
});
