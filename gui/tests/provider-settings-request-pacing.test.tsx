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
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

test("settings saves provider pacing and a slower model override", async () => {
  const item: WorkspaceItem = {
    name: "nvidia",
    adapter: "openai-chat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
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
      availableModels={["deepseek-ai/deepseek-v4-flash-0731"]}
      onUpdateProvider={async (_name, patch) => { patches.push(patch); return { ok: true }; }}
    /></LanguageProvider>);
  });

  await act(async () => { container.querySelector<HTMLInputElement>(".pwi-pacing-toggle input")!.click(); });
  const numbers = container.querySelectorAll<HTMLInputElement>('.pwi-pacing-card input[type="number"]');
  await setInput(numbers[0]!, "38");
  const modelInput = container.querySelector<HTMLInputElement>('.pwi-pacing-grid--model input[list]')!;
  await setInput(modelInput, "deepseek-ai/deepseek-v4-flash-0731");
  await setInput(numbers[2]!, "10");
  await act(async () => { container.querySelector<HTMLButtonElement>(".pwi-pacing-grid--model button")!.click(); });
  const save = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!;
  await act(async () => { save.click(); await Promise.resolve(); });

  expect(patches).toEqual([{
    requestPacing: {
      enabled: true,
      requestsPerMinute: 38,
      models: { "deepseek-ai/deepseek-v4-flash-0731": { requestsPerMinute: 10 } },
    },
  }]);
  expect(container.textContent).toContain("deepseek-ai/deepseek-v4-flash-0731");
  await act(async () => { root.unmount(); });
});
