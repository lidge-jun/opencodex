import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ClaudeDesktopPicker, { type DesktopPickerStatus } from "../src/components/ClaudeDesktopPicker";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: { url: string; init?: RequestInit }[] = [];

const basePicker: DesktopPickerStatus = {
  desired: true,
  supported: true,
  trust: "trusted",
  profile: "applied",
  listenerReady: true,
  effective: true,
  reason: "active",
  models: 4,
  snapshotAt: null,
  lastBootstrapAt: null,
};

function installFetch(response: (request: { url: string; init?: RequestInit }) => { status: number; body: unknown }) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const request = { url: String(url), init };
      requests.push(request);
      const next = response(request);
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.body,
        text: async () => JSON.stringify(next.body),
      } as unknown as Response;
    },
  });
}

beforeEach(() => {
  requests = [];
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installFetch(() => ({ status: 200, body: { ok: true, picker: { ...basePicker, desired: false, effective: false, reason: "proxy_unavailable" } } }));
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mount(picker = basePicker) {
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ClaudeDesktopPicker apiBase="" picker={picker} /></LanguageProvider>);
  });
}

test("renders active state, model count, and the fixed offline note", async () => {
  await mount();
  expect(container.querySelector(".claude-picker-title")?.textContent).toBe("Claude Desktop picker");
  expect(container.querySelector(".claude-picker-state")?.textContent).toContain("Picker is active");
  expect(container.querySelector(".claude-picker-models")?.textContent).toContain("4 models");
  expect(container.querySelector(".claude-picker-offline-note")?.textContent).toContain("Claude Desktop reaches the network through OpenCodex");
  expect(container.querySelector("[role=switch]")?.getAttribute("aria-checked")).toBe("true");
});

test("sends the persisted toggle and renders a reported proxy refusal", async () => {
  let response: { status: number; body: unknown } = {
    status: 503,
    body: { ok: false, code: "picker_proxy_unavailable", picker: { ...basePicker, effective: false, reason: "proxy_unavailable" } },
  };
  installFetch(() => response);
  await mount();
  await act(async () => { (container.querySelector("[role=switch]") as HTMLButtonElement).click(); });

  expect(requests[0]?.url).toBe("/api/claude-desktop/picker");
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ enabled: false, persist: true });
  expect(container.querySelector(".claude-picker-state")?.textContent).toContain("Picker proxy is not running");
  expect(container.querySelector(".notice-err")).toBeNull();
  response = { status: 200, body: { ok: true, picker: { ...basePicker, reason: "trust_pending", hint: "ocx claude desktop picker trust" } } };
  await act(async () => { (container.querySelector("[role=switch]") as HTMLButtonElement).click(); });
  expect(container.querySelector(".claude-picker-state")?.textContent).toContain("Waiting for the keychain step");
  expect(container.querySelector(".claude-picker-state code")?.textContent).toBe("ocx claude desktop picker trust");
});
