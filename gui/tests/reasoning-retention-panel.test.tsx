/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ReasoningRetentionPanel from "../src/components/ReasoningRetentionPanel";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let container: HTMLDivElement;
let setting: { maxContextPercent?: number; maxTokens?: number } | null;
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
  setting = null; failLoad = false; failSave = false; writes = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (failSave) return Response.json({ error: "fixture failure" }, { status: 500 });
      setting = body.reasoningRetention;
    } else if (failLoad) return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ reasoningRetention: setting });
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
  await act(async () => { root!.render(<StrictMode><LanguageProvider><ReasoningRetentionPanel apiBase={base} /></LanguageProvider></StrictMode>); });
  await flush();
}
function button(text: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!; }
async function change(id: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`#reasoning-retention-${id}`)!;
    input.value = value;
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
}
test("loads defaults, saves custom limits and resets to defaults", async () => {
  await render();
  expect(container.querySelector<HTMLInputElement>('#reasoning-retention-percent')!.value).toBe("20");
  expect(container.querySelector<HTMLInputElement>('#reasoning-retention-tokens')!.value).toBe("100000");
  await change("percent", "12.5");
  await change("tokens", "50000");
  await act(async () => { button("Save").click(); });
  expect(writes).toEqual([{ reasoningRetention: { maxContextPercent: 12.5, maxTokens: 50000 } }]);
  await render("/reload");
  expect(container.querySelector<HTMLInputElement>('#reasoning-retention-tokens')!.value).toBe("50000");
  await act(async () => { button("Restore defaults").click(); });
  expect(writes.at(-1)).toEqual({ reasoningRetention: null });
  expect(container.querySelector<HTMLInputElement>('#reasoning-retention-percent')!.value).toBe("20");
});
test("invalid numeric limits disable save and expose validation", async () => {
  await render();
  for (const [id, value] of [["percent", "0"], ["percent", "101"], ["tokens", "1.5"], ["tokens", ""]]) {
    await change(id, value);
    expect(button("Save").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await change("percent", "20"); await change("tokens", "100000");
  }
  expect(writes).toEqual([]);
});
test.each([["percent", "0", "tokens", "12.5"], ["tokens", "1.5", "percent", "50000"]])(
  "only invalid %s is associated with the validation alert", async (id, invalidValue, otherId, validValue) => {
    await render();
    await change(id!, invalidValue!);
    const invalid = container.querySelector<HTMLInputElement>(`#reasoning-retention-${id}`)!;
    const valid = container.querySelector<HTMLInputElement>(`#reasoning-retention-${otherId}`)!;
    expect(invalid.getAttribute("aria-invalid")).toBe("true");
    expect(invalid.getAttribute("aria-describedby")).toBe("reasoning-retention-error");
    expect(valid.getAttribute("aria-invalid")).toBeNull();
    expect(valid.getAttribute("aria-describedby")).toBeNull();
    expect(container.querySelector("#reasoning-retention-error")?.getAttribute("role")).toBe("alert");
    expect(button("Save").disabled).toBe(true);
    await change(id!, validValue!);
    expect(invalid.getAttribute("aria-invalid")).toBeNull();
    expect(invalid.getAttribute("aria-describedby")).toBeNull();
    expect(container.querySelector("#reasoning-retention-error")).toBeNull();
    expect(button("Save").disabled).toBe(false);
    expect(writes).toEqual([]);
  },
);
test("save failures keep edits and load failures can retry", async () => {
  failLoad = true; await render();
  expect(button("Save").disabled).toBe(true);
  failLoad = false;
  await act(async () => { button("Retry").click(); });
  await change("tokens", "50000"); failSave = true;
  await act(async () => { button("Save").click(); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save");
  expect(container.querySelector<HTMLInputElement>('#reasoning-retention-tokens')!.value).toBe("50000");
});

test("missing settings payload disables writes instead of assuming defaults", async () => {
  const normalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({})) as typeof fetch;
  await render();
  expect(button("Save").disabled).toBe(true);
  expect(button("Restore defaults").disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  globalThis.fetch = normalFetch;
  await act(async () => { button("Retry").click(); });
  await change("tokens", "50000");
  expect(button("Save").disabled).toBe(false);
});

test("pending save disables controls and duplicate clicks send only one update", async () => {
  await render();
  await change("tokens", "50000");
  const pending = Promise.withResolvers<Response>();
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    writes.push(JSON.parse(String(init?.body)));
    return pending.promise;
  }) as typeof fetch;
  await act(async () => { button("Save").click(); button("Save").click(); });
  expect(writes).toHaveLength(1);
  expect(button("Save").disabled).toBe(true);
  expect(container.querySelector<HTMLInputElement>('#reasoning-retention-tokens')!.disabled).toBe(true);
  await act(async () => { pending.resolve(Response.json({ reasoningRetention: { maxTokens: 50000, maxContextPercent: 20 } })); });
  expect(container.querySelector('[role="status"]')?.textContent).toContain("saved");
});

test("a late response from the previous API target cannot replace current settings", async () => {
  const pending = Promise.withResolvers<Response>();
  globalThis.fetch = (async (input: unknown) => String(input).startsWith("/old/")
    ? pending.promise : Response.json({ reasoningRetention: { maxTokens: 60000 } })) as typeof fetch;
  await render("/old");
  expect(button("Save").disabled).toBe(true);
  await render("/new");
  expect(container.querySelector<HTMLInputElement>('#reasoning-retention-tokens')!.value).toBe("60000");
  await act(async () => { pending.resolve(Response.json({ reasoningRetention: { maxTokens: 123 } })); });
  expect(container.querySelector<HTMLInputElement>('#reasoning-retention-tokens')!.value).toBe("60000");
});
