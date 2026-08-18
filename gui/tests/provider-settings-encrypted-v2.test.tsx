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

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  Object.defineProperty(testWindow, "confirm", { configurable: true, value: () => true });
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
  expect(optInLabel?.textContent).toContain("opaque encrypted task");
  await act(async () => { optInLabel!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!.click();
    await Promise.resolve();
  });

  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatchObject({ allowEncryptedV2AgentTasks: true });
  await act(async () => { root.unmount(); });
});
