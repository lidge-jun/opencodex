/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ApiKeysWorkspace, { type ApiKeysWorkspaceProps } from "../src/components/apikeys-workspace/ApiKeysWorkspace";
import { LanguageProvider } from "../src/i18n/provider";
import type { ApiEndpointInfo } from "../src/pages/api-keys-utils";

// The key table's own row actions: a delete that is visible without hovering
// and confirms in place, and a key that reveals its full value on click.

const endpoints: ApiEndpointInfo = {
  baseUrl: "http://127.0.0.1:10100/v1",
  responses: "http://127.0.0.1:10100/v1/responses",
  chatCompletions: "http://127.0.0.1:10100/v1/chat/completions",
  messages: "http://127.0.0.1:10100/v1/messages",
  models: "http://127.0.0.1:10100/v1/models",
};

const AUTH_MATRIX = [
  { endpoint: "/v1/responses", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
] as const;

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let active: Root | null = null;
let rerender: (props: Partial<ApiKeysWorkspaceProps>) => Promise<void> = async () => {};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (active) {
    const root = active;
    active = null;
    rerender = async () => {};
    await act(async () => { root.unmount(); });
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(props: Partial<ApiKeysWorkspaceProps>): Promise<HTMLDivElement> {
  // Use the GLOBAL document (which beforeEach points at testWindow): React reads
  // globals, so a container created off the raw window object is not the same
  // document it renders into, and synthetic input events never reach it.
  const container = document.createElement("div");
  document.body.append(container);
  const value: ApiKeysWorkspaceProps = {
    keys: [{
      id: "k1",
      name: "alpha",
      prefix: "ocx_data_aaaaaaaa...",
      createdAt: "2026-01-01T00:00:00.000Z",
      usage: { requests7d: 0, totalRequests: 0 },
    }],
    attributionSince: "2026-07-01T00:00:00.000Z",
    authMatrix: [...AUTH_MATRIX],
    keysLoading: false,
    keysLoadFailed: false,
    endpoints,
    claudeCodeEnabled: true,
    newName: "",
    creating: false,
    newKey: null,
    copied: false,
    filteredModels: [],
    modelsLoading: false,
    modelsLoadFailed: false,
    modelCount: 0,
    hasModelData: true,
    modelQuery: "",
    copiedModelId: null,
    modelTests: {},
    canTestModels: false,
    onNewNameChange: () => {},
    onCreate: () => {},
    onDismissNewKey: () => {},
    onCopyKey: () => {},
    onDelete: async () => true,
    onRename: async () => true,
    onModelQueryChange: () => {},
    onRetryModels: () => {},
    onCopyModelId: () => {},
    onTestModel: () => {},
    sourceLabel: () => "proxy",
    protocolLabel: p => p,
    ...props,
  };
  // Import AFTER beforeEach installed the globals: a module-level import binds
  // react-dom to whatever document existed at load time, and synthetic events
  // then never reach the tree React actually rendered into.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  active = root;
  rerender = async next => {
    await act(async () => {
      root.render(<LanguageProvider><ApiKeysWorkspace {...value} {...next} /></LanguageProvider>);
    });
  };
  await act(async () => { root.render(<LanguageProvider><ApiKeysWorkspace {...value} /></LanguageProvider>); });
  return container;
}

const button = (c: HTMLElement, text: string): HTMLButtonElement =>
  [...c.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;

const rowDelete = (c: HTMLElement): HTMLButtonElement =>
  c.querySelector<HTMLButtonElement>(".awi-keylist-delete")!;
const keyButton = (c: HTMLElement): HTMLButtonElement =>
  c.querySelector<HTMLButtonElement>(".awi-keylist-key")!;
const confirmButton = (c: HTMLElement): HTMLButtonElement =>
  c.querySelector<HTMLButtonElement>(".awi-keylist-confirm .btn-danger")!;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("every key row has a delete control without hovering, and it confirms in place", async () => {
  const deleted: string[] = [];
  const container = await mount({ onDelete: async id => { deleted.push(id); return true; } });
  const trigger = rowDelete(container);
  expect(trigger).not.toBeNull();
  expect(trigger.getAttribute("aria-label")).toBe("Delete alpha");
  // Nothing opened the detail pane: the action lives on the row itself.
  await act(async () => { trigger.click(); });
  expect(container.querySelector(".awi-detail")).toBeNull();
  // The click that opened the confirmation cannot land on the confirm button.
  expect(confirmButton(container).disabled).toBe(true);
  await act(async () => { confirmButton(container).click(); });
  expect(deleted).toEqual([]);
  await act(async () => { await wait(350); });
  expect(confirmButton(container).disabled).toBe(false);
  await act(async () => { confirmButton(container).click(); });
  expect(deleted).toEqual(["k1"]);
});

test("cancel backs out of a row delete, and a failed one says so beside the row", async () => {
  const container = await mount({ onDelete: async () => false });
  await act(async () => { rowDelete(container).click(); });
  await act(async () => { button(container, "Cancel").click(); });
  expect(container.querySelector(".awi-keylist-confirm")).toBeNull();
  expect(rowDelete(container)).not.toBeNull();

  await act(async () => { rowDelete(container).click(); });
  await act(async () => { await wait(350); });
  await act(async () => { confirmButton(container).click(); });
  const alert = container.querySelector(".awi-keylist-actions [role=\"alert\"]");
  expect(alert?.textContent).toBe("Could not delete API key.");
});

test("clicking the key shows the full value with a copy button, and clicking again hides it", async () => {
  const asked: string[] = [];
  const full = "ocx_data_" + "a".repeat(40);
  const container = await mount({ onRevealKey: async id => { asked.push(id); return full; } });
  expect(keyButton(container).textContent).toBe("ocx_data_aaaaaaaa...");
  expect(keyButton(container).getAttribute("aria-expanded")).toBe("false");

  await act(async () => { keyButton(container).click(); });
  expect(asked).toEqual(["k1"]);
  expect(keyButton(container).textContent).toBe(full);
  expect(keyButton(container).getAttribute("aria-expanded")).toBe("true");
  expect(button(container, "Copy")).toBeDefined();

  await act(async () => { keyButton(container).click(); });
  expect(keyButton(container).textContent).toBe("ocx_data_aaaaaaaa...");
  expect(container.querySelector(".awi-keylist-copy")).toBeNull();
  // Hiding is local; it does not spend another round trip.
  expect(asked).toEqual(["k1"]);
});

test("a refused reveal keeps the prefix and reports the failure", async () => {
  const container = await mount({ onRevealKey: async () => null });
  await act(async () => { keyButton(container).click(); });
  expect(keyButton(container).textContent).toBe("ocx_data_aaaaaaaa...");
  expect(container.querySelector(".awi-keylist-keycell [role=\"alert\"]")?.textContent).toBe("Could not load the full key.");
});

test("without a reveal handler the key stays plain text", async () => {
  const container = await mount({});
  expect(container.querySelector(".awi-keylist-key")).toBeNull();
  expect(container.querySelector(".awi-keylist-keycell code")?.textContent).toBe("ocx_data_aaaaaaaa...");
});

test("a rotated key does not keep showing the value it replaced", async () => {
  const before = "ocx_data_" + "a".repeat(40);
  const container = await mount({ onRevealKey: async () => before });
  await act(async () => { keyButton(container).click(); });
  expect(keyButton(container).textContent).toBe(before);
  await rerender({
    onRevealKey: async () => before,
    keys: [{ id: "k1", name: "alpha", prefix: "ocx_data_bbbbbbbb...", createdAt: "2026-01-01T00:00:00.000Z",
      usage: { requests7d: 0, totalRequests: 0 } }],
  });
  expect(keyButton(container).textContent).toBe("ocx_data_bbbbbbbb...");
  expect(container.querySelector(".awi-keylist-copy")).toBeNull();
});

test("a reveal that answers after the key was deleted stays discarded", async () => {
  let answer: (value: string) => void = () => {};
  const container = await mount({
    onRevealKey: () => new Promise<string>(resolve => { answer = resolve; }),
    onDelete: async () => true,
  });
  await act(async () => { keyButton(container).click(); });
  await act(async () => { rowDelete(container).click(); });
  await act(async () => { await wait(350); });
  await act(async () => { confirmButton(container).click(); });
  await act(async () => { answer("ocx_data_" + "a".repeat(40)); });
  expect(keyButton(container).textContent).toBe("ocx_data_aaaaaaaa...");
  expect(container.querySelector(".awi-keylist-copy")).toBeNull();
});

test("a copy the clipboard refuses says so beside the key", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
  const container = await mount({ onRevealKey: async () => "ocx_data_" + "a".repeat(40) });
  await act(async () => { keyButton(container).click(); });
  await act(async () => { button(container, "Copy").click(); });
  expect(container.querySelector(".awi-keylist-keycell [role=\"alert\"]")?.textContent)
    .toBe("Could not copy. Select the key and copy it manually.");
  expect(button(container, "Copy")).toBeDefined();
});

test("a successful copy shows Copied and then returns to Copy", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (v: string) => { written.push(v); } } });
  const full = "ocx_data_" + "a".repeat(40);
  const container = await mount({ onRevealKey: async () => full });
  await act(async () => { keyButton(container).click(); });
  await act(async () => { button(container, "Copy").click(); });
  expect(written).toEqual([full]);
  expect(button(container, "Copied")).toBeDefined();
  await act(async () => { await wait(2050); });
  expect(button(container, "Copy")).toBeDefined();
});
