import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

async function renderSettings(
  item: WorkspaceItem,
  onUpdateProvider: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean }>,
): Promise<HTMLDivElement & { unmount: () => void }> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ProviderSettings
      item={item}
      availableModels={["deepseek-ai/deepseek-v4-flash-0731"]}
      onUpdateProvider={onUpdateProvider}
    /></LanguageProvider>);
  });
  return Object.assign(container, { unmount: () => root.unmount() });
}

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
  const container = await renderSettings(item, async (_name, patch) => { patches.push(patch); return { ok: true }; });

  await act(async () => { container.querySelector<HTMLInputElement>(".pwi-pacing-toggle input")!.click(); });
  const providerNumbers = container.querySelectorAll<HTMLInputElement>('.pwi-pacing-grid:not(.pwi-pacing-grid--model) input[type="number"]');
  await setInput(providerNumbers[0]!, "38");
  await setInput(providerNumbers[2]!, "8");
  const modelInput = container.querySelector<HTMLInputElement>('.pwi-pacing-grid--model input[list]')!;
  await setInput(modelInput, "deepseek-ai/deepseek-v4-flash-0731");
  const modelNumbers = container.querySelectorAll<HTMLInputElement>('.pwi-pacing-grid--model input[type="number"]');
  await setInput(modelNumbers[0]!, "10");
  await setInput(modelNumbers[2]!, "2");
  await act(async () => { container.querySelector<HTMLButtonElement>(".pwi-pacing-grid--model button")!.click(); });
  const save = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!;
  await act(async () => { save.click(); await Promise.resolve(); });

  expect(patches).toEqual([{
    requestPacing: {
      enabled: true,
      requestsPerMinute: 38,
      maxConcurrentRequests: 8,
      models: { "deepseek-ai/deepseek-v4-flash-0731": { requestsPerMinute: 10, maxConcurrentRequests: 2 } },
    },
  }]);
  expect(container.textContent).toContain("deepseek-ai/deepseek-v4-flash-0731");
  await act(async () => { container.unmount(); });
});

test("a concurrency-only pacing rule saves without the rule-required error", async () => {
  const item: WorkspaceItem = {
    name: "nvidia",
    adapter: "openai-chat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authMode: "key",
  };
  const patches: ProviderUpdatePatch[] = [];
  const container = await renderSettings(item, async (_name, patch) => { patches.push(patch); return { ok: true }; });

  await act(async () => { container.querySelector<HTMLInputElement>(".pwi-pacing-toggle input")!.click(); });
  const providerNumbers = container.querySelectorAll<HTMLInputElement>('.pwi-pacing-grid:not(.pwi-pacing-grid--model) input[type="number"]');
  await setInput(providerNumbers[2]!, "4");
  const save = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!;
  await act(async () => { save.click(); await Promise.resolve(); });

  expect(patches).toEqual([{ requestPacing: { enabled: true, maxConcurrentRequests: 4 } }]);
  expect(container.textContent).not.toContain("Enable request pacing only after setting a provider limit");
  await act(async () => { container.unmount(); });
});

test("discard reverts an unsaved concurrency draft to the stored cap", async () => {
  const item: WorkspaceItem = {
    name: "nvidia",
    adapter: "openai-chat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authMode: "key",
    requestPacing: { enabled: true, requestsPerMinute: 120, maxConcurrentRequests: 5 },
  };
  const patches: ProviderUpdatePatch[] = [];
  const container = await renderSettings(item, async (_name, patch) => { patches.push(patch); return { ok: true }; });

  const providerNumbers = container.querySelectorAll<HTMLInputElement>('.pwi-pacing-grid:not(.pwi-pacing-grid--model) input[type="number"]');
  expect(providerNumbers[2]!.value).toBe("5");
  await setInput(providerNumbers[2]!, "9");
  expect(providerNumbers[2]!.value).toBe("9");

  const discard = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-ghost")!;
  await act(async () => { discard.click(); });

  expect(providerNumbers[2]!.value).toBe("5");
  expect(patches).toEqual([]);
  await act(async () => { container.unmount(); });
 });

test("pacing grids keep every field and the add button on one row", async () => {
  const css = await Bun.file(new URL("../src/styles/provider-workspace-settings.css", import.meta.url)).text();
  // The provider grid owns three inputs (rpm, interval, concurrency) and the model
  // grid owns five children (name, rpm, interval, concurrency, add). A template with
  // fewer tracks wraps the tail onto a half-empty second row.
  const providerStart = css.indexOf(".pwi-pacing-grid {");
  expect(providerStart).toBeGreaterThan(-1);
  const providerRule = css.slice(providerStart, css.indexOf("}", providerStart));
  expect(providerRule).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
  const modelStart = css.indexOf(".pwi-pacing-grid--model {");
  expect(modelStart).toBeGreaterThan(-1);
  const modelRule = css.slice(modelStart, css.indexOf("}", modelStart));
  expect(modelRule).toContain("grid-template-columns: minmax(160px, 2fr) repeat(3, minmax(110px, 1fr)) auto");
});

test("an invalid nonempty concurrency draft blocks saving instead of silently dropping the cap", async () => {
  const item: WorkspaceItem = {
    name: "nvidia",
    adapter: "openai-chat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authMode: "key",
    requestPacing: { enabled: true, requestsPerMinute: 120, maxConcurrentRequests: 5 },
  };
  const patches: ProviderUpdatePatch[] = [];
  const container = await renderSettings(item, async (_name, patch) => { patches.push(patch); return { ok: true }; });

  const providerNumbers = container.querySelectorAll<HTMLInputElement>('.pwi-pacing-grid:not(.pwi-pacing-grid--model) input[type="number"]');
  await setInput(providerNumbers[2]!, "0");
  const save = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!;
  await act(async () => { save.click(); });
  expect(patches).toEqual([]);
  expect(container.textContent).toContain("Max concurrent requests must be a whole number of 1 or more.");

  // A blank draft stays the intentional way to clear a stored cap.
  await setInput(providerNumbers[2]!, "");
  await act(async () => { save.click(); });
  expect(patches).toHaveLength(1);
  expect(patches[0]!.requestPacing).toEqual({ enabled: true, requestsPerMinute: 120 });
  await act(async () => { container.unmount(); });
});

test("an invalid nonempty cap blocks replacing a model rule instead of dropping its cap", async () => {
  const item: WorkspaceItem = {
    name: "nvidia",
    adapter: "openai-chat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authMode: "key",
    requestPacing: { enabled: true, requestsPerMinute: 120, models: { "deepseek-ai/deepseek-v4-flash-0731": { requestsPerMinute: 60, maxConcurrentRequests: 5 } } },
  };
  const container = await renderSettings(item, async () => ({ ok: true }));

  const modelInput = container.querySelector<HTMLInputElement>('.pwi-pacing-grid--model input[list]')!;
  const modelNumbers = container.querySelectorAll<HTMLInputElement>('.pwi-pacing-grid--model input[type="number"]');
  await setInput(modelInput, "deepseek-ai/deepseek-v4-flash-0731");
  await setInput(modelNumbers[0]!, "30");
  await setInput(modelNumbers[2]!, "0");
  await act(async () => { container.querySelector<HTMLButtonElement>(".pwi-pacing-grid--model button")!.click(); });

  expect(container.textContent).toContain("Max concurrent requests must be a whole number of 1 or more.");
  expect(container.querySelector(".pwi-pacing-overrides")!.textContent).toContain("5 ×");
  expect(modelNumbers[2]!.value).toBe("0");
  await act(async () => { container.unmount(); });
});
