import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { chooseOption, selectTrigger } from "./helpers/custom-select";

async function renderSettings(
  item: WorkspaceItem,
  onUpdateProvider: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean }>,
): Promise<HTMLDivElement & { unmount: () => void; rerender: (next: WorkspaceItem) => Promise<void> }> {
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
  return Object.assign(container, {
    unmount: () => root.unmount(),
    rerender: async (next: WorkspaceItem) => {
      await act(async () => {
        root.render(<LanguageProvider><ProviderSettings
          item={next}
          availableModels={["deepseek-ai/deepseek-v4-flash-0731"]}
          onUpdateProvider={onUpdateProvider}
        /></LanguageProvider>);
      });
    },
  });
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

test("Vertex settings can update project and clear location", async () => {
  const item = { name: "my-vertex", adapter: "google", baseUrl: "https://aiplatform.googleapis.com", authMode: "key",
    googleMode: "vertex", project: "old-project", location: "global" } as WorkspaceItem;
  const patches: ProviderUpdatePatch[] = [];
  const container = await renderSettings(item, async (_name, patch) => { patches.push(patch); return { ok: true }; });
  const inputFor = (label: string) => [...container.querySelectorAll("label")]
    .find(element => element.textContent?.includes(label))?.querySelector("input") as HTMLInputElement;
  const project = inputFor("Project ID");
  const location = inputFor("Location");
  expect(project).toBeDefined();
  expect(location).toBeDefined();
  await setInput(project, "new-project");
  await setInput(location, "");
  await act(async () => { container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!.click(); });
  expect(patches[0]).toMatchObject({ project: "new-project", location: "" });
  await act(async () => { container.unmount(); });
});

test("canonical Vertex with an old saved URL exposes project and location settings", async () => {
  const item = { name: "google-vertex", adapter: "google", baseUrl: "https://legacy.example/v1", authMode: "key" } as WorkspaceItem;
  const container = await renderSettings(item, async () => ({ ok: true }));
  expect(container.textContent).toContain("Project ID");
  expect(container.textContent).toContain("Location");
  await act(async () => { container.unmount(); });
});

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

test("key allocation and per-key limits save through the existing provider settings action", async () => {
  const patches: ProviderUpdatePatch[] = [];
  const container = await renderSettings({ name: "fixture", adapter: "openai-chat", baseUrl: "https://example.test", authMode: "key" },
    async (_name, patch) => { patches.push(patch); return { ok: true }; });
  await act(async () => { container.querySelector<HTMLInputElement>(".pwi-pacing-toggle input")!.click(); });
  await chooseOption(selectTrigger(container, '[role="combobox"][aria-label="API key selection"]'), "round-robin");
  const numbers = container.querySelectorAll<HTMLInputElement>(".pwi-key-limits input");
  await setInput(numbers[0]!, "15"); await setInput(numbers[2]!, "1");
  await act(async () => { container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!.click(); });
  expect(patches[0]?.requestPacing).toMatchObject({ enabled: true, keySelection: "round-robin", keys: { requestsPerMinute: 15, maxConcurrentRequests: 1 } });
  expect(container.textContent).toContain("Keys in the same project may share quotas");
  container.unmount();
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

test("invalid key limits block save and discard restores the stored distribution policy", async () => {
  const patches: ProviderUpdatePatch[] = [];
  const container = await renderSettings({ name: "fixture", adapter: "openai-chat", baseUrl: "https://example.test", authMode: "key",
    requestPacing: { enabled: true, keySelection: "round-robin", keys: { requestsPerMinute: 15, maxConcurrentRequests: 1 } } },
    async (_name, patch) => { patches.push(patch); return { ok: true }; });
  const numbers = container.querySelectorAll<HTMLInputElement>(".pwi-key-limits input");
  await setInput(numbers[2]!, "0");
  await act(async () => { container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!.click(); });
  expect(patches).toEqual([]);
  expect(container.textContent).toContain("Per-key limits must be positive");
  await act(async () => { container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-ghost")!.click(); });
  expect(numbers[2]!.value).toBe("1"); expect(numbers[0]!.value).toBe("15");
  await act(async () => { container.unmount(); });
});

test("per-key pacing bounds match the runtime validator", async () => {
  const patches: ProviderUpdatePatch[] = [];
  const container = await renderSettings({ name: "fixture", adapter: "openai-chat", baseUrl: "https://example.test", authMode: "key" },
    async (_name, patch) => { patches.push(patch); return { ok: true }; });
  await act(async () => { container.querySelector<HTMLInputElement>(".pwi-pacing-toggle input")!.click(); });
  const keyNumbers = container.querySelectorAll<HTMLInputElement>(".pwi-key-limits input");
  const save = () => container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!;

  // RPM above the runtime's 60_000 cap is refused, never clamped or saved.
  await setInput(keyNumbers[0]!, "60001");
  await act(async () => { save().click(); });
  expect(patches).toEqual([]);
  expect(container.textContent).toContain("Per-key limits must be positive");

  // Interval above the runtime's 3_600_000 ms cap is refused too.
  await setInput(keyNumbers[0]!, "15");
  await setInput(keyNumbers[1]!, "3600001");
  await act(async () => { save().click(); });
  expect(patches).toEqual([]);

  // The exact upper bounds from the runtime validator are accepted.
  await setInput(keyNumbers[1]!, "3600000");
  await act(async () => { save().click(); });
  expect(patches[0]?.requestPacing).toMatchObject({ keys: { requestsPerMinute: 15, minIntervalMs: 3_600_000 } });
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

test("nonempty invalid RPM, delay and model values are rejected instead of silently dropped", async () => {
  const patches: ProviderUpdatePatch[] = [];
  const item: WorkspaceItem = { name: "fixture", adapter: "openai-chat", baseUrl: "https://example.test", authMode: "key" };
  const container = await renderSettings(item, async (_name, patch) => { patches.push(patch); return { ok: true }; });
  await act(async () => { container.querySelector<HTMLInputElement>(".pwi-pacing-toggle input")!.click(); });
  const providerNumbers = container.querySelectorAll<HTMLInputElement>('.pwi-pacing-grid:not(.pwi-pacing-grid--model) input[type="number"]');
  await setInput(providerNumbers[0]!, "70000");
  await act(async () => { container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!.click(); });
  expect(patches).toHaveLength(0);
  expect(container.textContent).toContain("Enter a valid pacing value");

  await setInput(providerNumbers[0]!, "30");
  await setInput(providerNumbers[1]!, "3600001");
  await act(async () => { container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!.click(); });
  expect(patches).toHaveLength(0);

  await setInput(providerNumbers[1]!, "");
  const modelInput = container.querySelector<HTMLInputElement>('.pwi-pacing-grid--model input[list]')!;
  const modelNumbers = container.querySelectorAll<HTMLInputElement>('.pwi-pacing-grid--model input[type="number"]');
  await setInput(modelInput, "model-a");
  await setInput(modelNumbers[0]!, "0");
  await act(async () => { container.querySelector<HTMLButtonElement>(".pwi-pacing-grid--model button")!.click(); });
  expect(container.textContent).toContain("Enter a valid pacing value");
  expect(container.querySelector(".pwi-pacing-overrides")).toBeNull();
});

test("a same-field pacing conflict lists its path and Keep resolves it", async () => {
  const patches: ProviderUpdatePatch[] = [];
  const item: WorkspaceItem = { name: "fixture", adapter: "openai-chat", baseUrl: "https://example.test", authMode: "key",
    requestPacing: { enabled: true, requestsPerMinute: 30 } };
  const container = await renderSettings(item, async (_name, patch) => { patches.push(patch); return { ok: true }; });
  const numbers = container.querySelectorAll<HTMLInputElement>('.pwi-pacing-grid:not(.pwi-pacing-grid--model) input[type="number"]');
  await setInput(numbers[0]!, "31");
  await container.rerender({ ...item, requestPacing: { enabled: true, requestsPerMinute: 32 } });
  expect(container.textContent).toContain("pacing.requestsPerMinute");
  const keep = [...container.querySelectorAll<HTMLButtonElement>("button")].find(candidate => candidate.textContent === "Keep my draft")!;
  await act(async () => { keep.click(); });
  expect(container.textContent).not.toContain("pacing.requestsPerMinute");
  const save = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!;
  await act(async () => { save.click(); await Promise.resolve(); });
  expect(patches[0]?.requestPacing?.requestsPerMinute).toBe(31);
});
