import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage",
  "IS_REACT_ACT_ENVIRONMENT", "fetch", "setInterval", "clearInterval"] as const;
let previous: PropertyDescriptor[];
let win: Window;
let container: HTMLElement;
let root: Root;
let requests: Array<{ enabled: boolean; provider: string; scope: string; targets: Array<{ id: string }> }>;
let writes: Array<(response?: Response) => void>;
let reads: number;
let writeSignal: AbortSignal | null | undefined;
let disabled: Set<string>;
let heldRead: { promise: Promise<Response>; resolve(response: Response): void } | null;
const models = () => ["a", "b"].map(id => ({ provider: "proxy", id, namespaced: `proxy/${id}`, disabled: disabled.has(id) }));
const providers = [{ name: "proxy", liveModels: false, models: ["a", "b"] }];

beforeEach(() => {
  clearClientResourceStoresForTests();
  previous = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key)!);
  win = new Window({ url: "http://localhost/#models" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    setInterval: { configurable: true, value: () => 1 }, clearInterval: { configurable: true, value: () => {} },
  });
  requests = []; writes = []; reads = 0; writeSignal = undefined; disabled = new Set(); heldRead = null;
  win.localStorage.setItem("ocx-models-collapsed:v2", "[]");
  win.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({ models: models(), providers,
    selectedModels: {}, disabled: [], contextCaps: {}, contextCapValue: 350_000 }));
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/model-visibility") {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      writeSignal = init?.signal;
      return new Promise<Response>(resolve => writes.push(response => {
        if (!response || response.ok) for (const target of body.targets) {
          if (body.enabled) disabled.delete(target.id); else disabled.add(target.id);
        }
        resolve(response ?? Response.json({ ok: true, clientIntegrations: [] }));
      }));
    }
    if (path === "/api/models") { reads++; return heldRead ? heldRead.promise : Response.json(models()); }
    if (path === "/api/providers") return Response.json(providers);
    if (path === "/api/selected-models") return Response.json({ selected: {} });
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

async function mount(apiBase = "http://localhost") {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Models apiBase={apiBase} reportRestart={() => {}} /></LanguageProvider>);
  });
}
const row = (id: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="proxy/${id}"]`)!;
const pressed = (id: string) => row(id).getAttribute("aria-pressed");
async function click(id: string) { await act(async () => { row(id).click(); }); }
async function settle(response?: Response) { await act(async () => { writes.shift()!(response); }); }
function holdRead() {
  let resolve!: (response: Response) => void;
  heldRead = { promise: new Promise<Response>(done => { resolve = done; }), resolve: response => resolve(response) };
}

test("slow writes allow immediate successive toggles and preserve last intent in order", async () => {
  await mount();
  const initialReads = reads;
  await click("a");
  expect(pressed("a")).toBe("false");
  expect(row("b").disabled).toBe(false);
  await click("b");
  await click("a");
  expect(pressed("a")).toBe("true");
  expect(pressed("b")).toBe("false");
  expect(requests).toHaveLength(1);
  expect(container.querySelector(".action-toast")).toBeNull();
  await settle();
  expect(requests.map(body => [body.targets[0].id, body.enabled])).toEqual([["a", false], ["b", false]]);
  expect(reads).toBe(initialReads);
  await settle();
  await settle();
  expect(requests.map(body => [body.targets[0].id, body.enabled])).toEqual([["a", false], ["b", false], ["a", true]]);
  expect(reads).toBe(initialReads + 1);
  expect(pressed("a")).toBe("true");
  expect(pressed("b")).toBe("false");
  expect(container.querySelector(".action-toast")?.className).toContain("notice-ok");
});

test("bulk visibility can queue behind a row write and updates all rows immediately", async () => {
  await mount();
  await click("a");
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "All off")!.click();
  });
  expect(pressed("a")).toBe("false"); expect(pressed("b")).toBe("false");
  await settle();
  expect(requests[1].scope).toBe("provider");
  await settle();
  expect(pressed("b")).toBe("false");
});

test("a refused save reconciles actual visibility and reports an error", async () => {
  await mount();
  await click("a");
  expect(pressed("a")).toBe("false");
  await settle(Response.json({ error: "refused" }, { status: 409 }));
  expect(pressed("a")).toBe("true");
  expect(row("a").disabled).toBe(false);
  expect(container.querySelector(".action-toast")?.className).toContain("notice-err");
});

test("transport failure releases controls, reconciles state, and reports an error", async () => {
  await mount();
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/model-visibility")) throw new TypeError("network unavailable");
    return original(input, init);
  }) as typeof fetch;
  await click("a");
  expect(pressed("a")).toBe("true");
  expect(row("a").disabled).toBe(false);
  expect(container.querySelector(".action-toast")?.className).toContain("notice-err");
});

test("a saved write whose reconciliation fails never publishes success", async () => {
  await mount();
  const original = globalThis.fetch;
  await click("a");
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/models")) return new Response(null, { status: 503 });
    return original(input, init);
  }) as typeof fetch;
  await settle();
  expect(disabled.has("a")).toBe(true);
  expect(row("a").disabled).toBe(false);
  expect(container.querySelector(".action-toast")?.className).toContain("notice-err");
});

for (const response of [() => new Response(null, { status: 204 }), () => new Response("saved")]) {
  test("a successful visibility write without JSON reconciles without a network error", async () => {
    await mount();
    await click("a");
    await settle(response());
    expect(pressed("a")).toBe("false");
    expect(container.querySelector(".action-toast")?.className).toContain("notice-ok");
    expect(container.querySelector(".action-toast")?.textContent).not.toContain("Network");
  });
}

test("a click during reconciliation survives the old read and starts another ordered write", async () => {
  await mount();
  await click("a");
  holdRead();
  await settle();
  await click("a");
  expect(pressed("a")).toBe("true");
  const oldRead = heldRead!;
  heldRead = null;
  await act(async () => { oldRead.resolve(Response.json(models())); });
  expect(pressed("a")).toBe("true");
  expect(requests).toHaveLength(2);
  await settle();
  expect(pressed("a")).toBe("true");
});

test("changing API target discards queued writes and ignores the old write's completion", async () => {
  await mount();
  await click("a"); await click("b");
  await act(async () => {
    root.render(<LanguageProvider><Models apiBase="http://other" reportRestart={() => {}} /></LanguageProvider>);
  });
  expect(writeSignal?.aborted).toBe(true);
  await settle(Response.json({ error: "old target failure" }, { status: 500 }));
  expect(requests).toHaveLength(1);
  expect(container.querySelector(".action-toast")).toBeNull();
  expect(row("a").disabled).toBe(false);
});

test("returning to an earlier API target does not resurrect its discarded optimistic draft", async () => {
  await mount();
  await click("a"); await click("b");
  for (const apiBase of ["http://other", "http://localhost"]) {
    await act(async () => {
      root.render(<LanguageProvider><Models apiBase={apiBase} reportRestart={() => {}} /></LanguageProvider>);
    });
  }
  expect(pressed("a")).toBe("true");
  expect(pressed("b")).toBe("true");
  expect(row("a").disabled).toBe(false);
  await settle(Response.json({ error: "old failure" }, { status: 500 }));
  expect(requests).toHaveLength(1);
  expect(container.querySelector(".action-toast")).toBeNull();
});
