import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let confirmCalls: string[];
let confirmResult: boolean;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  confirmCalls = [];
  confirmResult = true;
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  Object.defineProperty(testWindow, "confirm", { configurable: true, value: (message: string) => { confirmCalls.push(message); return confirmResult; } });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

test("settings explicitly opt a Responses provider into encrypted V2 task passthrough", async () => {
  const item: WorkspaceItem = {
    name: "relay",
    adapter: "openai-responses",
    baseUrl: "https://relay.example.test/v1",
    authMode: "key",
  };
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ProviderSettings
      item={item}
      onUpdateProvider={async (_name, patch) => { patches.push(patch); return { ok: true }; }}
    /></LanguageProvider>);
  });

  const optInLabel = [...container.querySelectorAll<HTMLLabelElement>("label")]
    .find(label => label.textContent?.includes("encrypted V2 agent tasks"));
  expect(optInLabel).toBeTruthy();
  expect(optInLabel?.textContent).toContain("opaque encrypted V2 child-task ciphertext");
  await act(async () => { optInLabel!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  expect(confirmCalls).toHaveLength(1);
  expect(confirmCalls[0]).toContain("opaque encrypted V2 child-task ciphertext");
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!.click();
    await Promise.resolve();
  });

  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatchObject({ allowEncryptedV2AgentTasks: true });
  await act(async () => { root.unmount(); });
});

test("cancelling the encrypted V2 confirmation does not save the trust opt-in", async () => {
  confirmResult = false;
  const item: WorkspaceItem = {
    name: "relay",
    adapter: "openai-responses",
    baseUrl: "https://relay.example.test/v1",
    authMode: "key",
  };
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ProviderSettings
      item={item}
      onUpdateProvider={async (_name, patch) => { patches.push(patch); return { ok: true }; }}
    /></LanguageProvider>);
  });

  const optInLabel = [...container.querySelectorAll<HTMLLabelElement>("label")]
    .find(label => label.textContent?.includes("encrypted V2 agent tasks"));
  const checkbox = optInLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox).toBeTruthy();
  await act(async () => { checkbox!.click(); });
  expect(confirmCalls).toHaveLength(1);
  expect(checkbox!.checked).toBe(false);
  expect(container.querySelector(".pwi-settings-sticky-bar")).toBeNull();
  expect(patches).not.toContainEqual(expect.objectContaining({ allowEncryptedV2AgentTasks: true }));
  await act(async () => { root.unmount(); });
});

test("stale encrypted V2 opt-in is cleared before entering Responses", async () => {
  const item: WorkspaceItem = {
    name: "relay",
    adapter: "openai-chat",
    baseUrl: "https://relay.example.test/v1",
    authMode: "key",
    allowEncryptedV2AgentTasks: true,
  };
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ProviderSettings
      item={item}
      onUpdateProvider={async (_name, patch) => { patches.push(patch); return { ok: true }; }}
    /></LanguageProvider>);
  });

  const adapterSelect = [...container.querySelectorAll<HTMLSelectElement>("select")]
    .find(select => select.value === "openai-chat");
  expect(adapterSelect).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
      .set!.call(adapterSelect, "openai-responses");
    adapterSelect!.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });

  const optInLabel = [...container.querySelectorAll<HTMLLabelElement>("label")]
    .find(label => label.textContent?.includes("encrypted V2 agent tasks"));
  const checkbox = optInLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox).toBeTruthy();
  expect(checkbox!.checked).toBe(false);
  expect(confirmCalls).toHaveLength(0);

  await act(async () => {
    container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!.click();
    await Promise.resolve();
  });
  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatchObject({ adapter: "openai-responses", allowEncryptedV2AgentTasks: false });
  expect(patches.some(patch => patch.allowEncryptedV2AgentTasks === true)).toBe(false);
  expect(confirmCalls).toHaveLength(0);
  await act(async () => { root.unmount(); });
});
