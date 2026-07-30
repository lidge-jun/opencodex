import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { ClaudeCodeSettingsCard } from "../src/pages/claude-code-sections";
import type { ClaudeCodeState } from "../src/pages/claude-code-types";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
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
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const BASE_STATE: ClaudeCodeState = {
  enabled: true,
  authMode: "proxy",
  autoConnectSupported: false,
  systemEnv: false,
  fastMode: null,
  maxContextTokens: null,
  autoContext: true,
  autoCompactWindow: null,
  injectAgents: true,
  smallFastModel: "",
  effectiveModelEnv: {},
  available: [],
  aliases: [],
  port: 10100,
};

async function mountSettings(
  initial: ClaudeCodeState = BASE_STATE,
): Promise<{ root: Root; host: HTMLDivElement; getState: () => ClaudeCodeState }> {
  const host = document.createElement("div");
  document.body.append(host);
  let latest = initial;
  function Harness() {
    const [state, setState] = useState(initial);
    latest = state;
    return (
      <LanguageProvider>
        <ClaudeCodeSettingsCard
          state={state}
          autoCompactOptions={[{ value: "", label: "Default" }]}
          availableModels={state.available ?? []}
          onStateChange={setState}
        />
      </LanguageProvider>
    );
  }
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness />);
  });
  return { root, host, getState: () => latest };
}

function sidecarModelInputs(host: HTMLElement): HTMLInputElement[] {
  return [...host.querySelectorAll<HTMLInputElement>('input[aria-label="Model"]')];
}

function sidecarBackendTriggers(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button.select-trigger[aria-label="Backend"]')];
}

async function pickOption(trigger: HTMLButtonElement, label: string): Promise<void> {
  await act(async () => {
    trigger.click();
  });
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(el => el.textContent?.includes(label));
  expect(option).toBeTruthy();
  await act(async () => {
    option!.click();
  });
}

test("Inherit → Auto stays Auto and enables the sidecar model input", async () => {
  const { root, host, getState } = await mountSettings();
  const [webSearchTrigger] = sidecarBackendTriggers(host);
  const [webSearchModel] = sidecarModelInputs(host);
  expect(webSearchTrigger).toBeTruthy();
  expect(webSearchModel.disabled).toBe(true);
  expect(getState().webSearchSidecar).toBeUndefined();

  await pickOption(webSearchTrigger!, "Auto");

  expect(getState().webSearchSidecar).toEqual({ backend: undefined });
  expect(sidecarSelectLabel(host, 0)).toContain("Auto");
  expect(sidecarModelInputs(host)[0]!.disabled).toBe(false);

  await act(async () => { root.unmount(); });
});

test("Empty Auto draft keeps model input enabled until Inherit is chosen", async () => {
  const { root, host, getState } = await mountSettings();
  const [webSearchTrigger] = sidecarBackendTriggers(host);
  await pickOption(webSearchTrigger!, "Auto");

  const model = sidecarModelInputs(host)[0]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(model, "gpt-4o");
    model.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  expect(getState().webSearchSidecar).toEqual({ backend: undefined, model: "gpt-4o" });

  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(model, "");
    model.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });

  // Clearing the model must not collapse Auto back to Inherit.
  expect(getState().webSearchSidecar).toEqual({ backend: undefined, model: "" });
  expect(model.disabled).toBe(false);
  expect(sidecarSelectLabel(host, 0)).toContain("Auto");

  await pickOption(sidecarBackendTriggers(host)[0]!, "Use main setting");
  expect(getState().webSearchSidecar).toBeUndefined();
  expect(sidecarModelInputs(host)[0]!.disabled).toBe(true);

  await act(async () => { root.unmount(); });
});

function sidecarSelectLabel(host: HTMLElement, index: number): string {
  return sidecarBackendTriggers(host)[index]?.textContent ?? "";
}
