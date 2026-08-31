import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";

const globals = [
  "document", "window", "navigator", "localStorage", "sessionStorage",
  "IS_REACT_ACT_ENVIRONMENT", "setInterval", "clearInterval", "fetch",
] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let serverMode: "default" | "1m";
let failSave: boolean;
let releaseSave: (() => void) | null;
const patches: Array<Record<string, unknown>> = [];

const models = [
  { provider: "openai", id: "gpt-5.6-sol", namespaced: "gpt-5.6-sol", native: true, disabled: false },
  { provider: "openrouter", id: "gpt-5.6-sol", namespaced: "openrouter/gpt-5.6-sol", native: false, disabled: false },
];

function providers() {
  return [
    { name: "openai", authMode: "forward", codexNativeContextMode: serverMode },
    { name: "openrouter", authMode: "api-key" },
  ];
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  root = null;
  serverMode = "default";
  failSave = false;
  releaseSave = null;
  patches.length = 0;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    setInterval: { configurable: true, value: () => 1 },
    clearInterval: { configurable: true, value: () => {} },
  });
  testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));
  testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
    models,
    providers: providers(),
    selectedModels: {},
    disabled: [],
    contextCaps: {},
    contextCapValue: 350_000,
  }));
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const pathname = new URL(url, "http://localhost").pathname;
    if (pathname === "/api/models") return Response.json(models);
    if (pathname === "/api/providers" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(body);
      if (releaseSave !== null) await new Promise<void>(resolve => { releaseSave = resolve; });
      if (failSave) return Response.json({ error: "synthetic mode failure" }, { status: 500 });
      serverMode = body.codexNativeContextMode as "default" | "1m";
      return Response.json({ success: true, codexNativeContextMode: serverMode });
    }
    if (pathname === "/api/providers") return Response.json(providers());
    if (pathname === "/api/selected-models") return Response.json({ selected: {} });
    if (pathname === "/api/provider-context-caps") return Response.json({ caps: {} });
    if (pathname === "/api/combos") return Response.json({ combos: [] });
    if (pathname === "/api/shadow-call-settings") return Response.json({ enabled: false, model: "" });
    if (pathname === "/api/v2") return Response.json({ enabled: false, agentsMaxThreadsConflict: false, multiAgentMode: "default" });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  clearClientResourceStoresForTests();
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  testWindow.close();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("native GPT-5.6 shows Default / 1M while routed providers do not", async () => {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>);
  });
  await flush();

  const controls = container.querySelectorAll<HTMLElement>("[data-testid=native-gpt56-context-mode]");
  expect(controls.length).toBe(1); // routed openrouter row never gets the native control
  const control = () => container.querySelector<HTMLElement>("[data-testid=native-gpt56-context-mode]")!;
  const button = (label: string) => [...control().querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent === label)!;
  expect(button("Default").getAttribute("aria-checked")).toBe("true");
  expect(button("1M").getAttribute("aria-checked")).toBe("false");
});

test("native context save uses an isolated PATCH, disables both choices, and reloads truth on failure", async () => {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>);
  });
  await flush();

  const control = () => container.querySelector<HTMLElement>("[data-testid=native-gpt56-context-mode]")!;
  const button = (label: string) => [...control().querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent === label)!;

  releaseSave = () => {}; // hold the first PATCH so the pending UI can be asserted
  act(() => { button("1M").click(); });
  await Promise.resolve();
  expect(patches).toEqual([{ codexNativeContextMode: "1m" }]);
  expect(button("Default").disabled).toBe(true);
  expect(button("1M").disabled).toBe(true);
  button("Default").click();
  expect(patches.length).toBe(1); // disabled controls and the single-flight ref block repeats

  const settle = releaseSave;
  expect(settle).not.toBeNull();
  releaseSave = null;
  settle!();
  await flush();
  expect(button("1M").getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("context mode synced");

  failSave = true;
  act(() => { button("Default").click(); });
  await flush();
  expect(patches).toEqual([
    { codexNativeContextMode: "1m" },
    { codexNativeContextMode: "default" },
  ]);
  expect(button("1M").getAttribute("aria-checked")).toBe("true");
  expect(button("Default").getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).toContain("synthetic mode failure");
});
