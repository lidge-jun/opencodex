import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  Window,
  type HTMLButtonElement as HappyHTMLButtonElement,
  type HTMLElement as HappyHTMLElement,
  type HTMLInputElement as HappyHTMLInputElement,
} from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { DashboardSidecarPanels } from "../src/pages/dashboard-overview-sections";
import type { SidecarData, SidecarPatch } from "../src/pages/dashboard-shared";
import { mergeSidecarSetting } from "../src/pages/dashboard-shared";
import type { useDashboardData } from "../src/pages/use-dashboard-data";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null = null;

type Dash = ReturnType<typeof useDashboardData>;

const initialSidecar: SidecarData = {
  webSearch: { model: "gpt-5.6-luna", streamRoutedModelOutput: false },
  vision: {
    model: "gpt-5.6-luna",
    backend: "openai",
    reasoning: "medium",
    enabled: true,
    maxDescriptionsPerTurn: 12,
    timeoutMs: 30_000,
  },
  visionModels: [
    { value: "gpt-5.6-luna", label: "gpt-5.6-luna", backend: "openai", baseline: true },
    { value: "gpt-5.4-mini", label: "gpt-5.4-mini", backend: "openai", baseline: true },
  ],
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  root = null;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  try {
    if (root) {
      const current = root;
      await act(async () => { current.unmount(); });
    }
  } finally {
    root = null;
    testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

function harness(sidecar: SidecarData = initialSidecar) {
  const patches: SidecarPatch[] = [];
  let current = sidecar;
  const listeners: Array<() => void> = [];
  const saveSidecar = async (patch: SidecarPatch) => {
    patches.push(patch);
    current = {
      webSearch: mergeSidecarSetting(current.webSearch, patch.webSearch),
      vision: mergeSidecarSetting(current.vision, patch.vision),
      ...(current.visionModels ? { visionModels: current.visionModels } : {}),
    };
    for (const listener of listeners) listener();
  };
  const d = {
    t: (key: keyof typeof en, vars?: Record<string, string | number>) => {
      let out: string = en[key];
      if (vars) {
        for (const [name, value] of Object.entries(vars)) out = out.split(`{${name}}`).join(String(value));
      }
      return out;
    },
    settings: { codexAutoStart: true, port: 10100, hostname: "127.0.0.1" },
    settingsSaving: false,
    toggleCodexAutoStart: () => {},
    sidecar,
    sidecarSaving: false,
    sidecarModels: [{ value: "gpt-5.6-luna", label: "gpt-5.6-luna" }],
    visionModels: sidecar.visionModels ?? [],
    models: [
      { id: "gpt-5.6-luna", provider: "openai", namespaced: "gpt-5.6-luna", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "gpt-5.4-mini", provider: "openai", namespaced: "gpt-5.4-mini", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    ],
    saveSidecar,
    shadowCall: { enabled: false, model: "" },
    shadowCallSaving: false,
    shadowCallHelpTriggerRef: { current: null },
    shadowCallHelpOpen: false,
    setShadowCallHelpOpen: () => {},
    saveShadowCall: async () => {},
  } as unknown as Dash;
  listeners.push(() => {
    d.sidecar = current;
  });
  return { d, patches, getSidecar: () => current };
}

async function mount(d: Dash) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    if (!root) root = createRoot(host);
    root.render(<LanguageProvider><DashboardSidecarPanels d={d} /></LanguageProvider>);
  });
}

function visionCard() {
  return [...host.querySelectorAll(".dash-sidecar-row-card")].find(card =>
    card.textContent?.includes(en["dash.visionSidecar"]),
  ) as HTMLElement;
}

function advancedTrigger() {
  const card = visionCard();
  return [...card.querySelectorAll("button")]
    .find(button => button.textContent?.includes(en["dash.visionAdvanced"])) as HTMLButtonElement;
}

function modelTrigger() {
  const card = visionCard();
  return card.querySelector(
    `button[role="combobox"][aria-label="${en["dash.sidecarModel"]}"]`,
  ) as HTMLButtonElement;
}

function advancedInput(label: string): HappyHTMLInputElement | null {
  return testWindow.document.querySelector(
    `input[aria-label="${label}"]`,
  ) as HappyHTMLInputElement | null;
}

async function openAdvanced() {
  await act(async () => { advancedTrigger().click(); });
}

function popover(): HappyHTMLElement | null {
  return testWindow.document.querySelector(
    ".dash-vision-advanced-popover",
  ) as HappyHTMLElement | null;
}

test("Advanced settings opens a floating popover that closes on outside click and Escape", async () => {
  await mount(harness().d);
  expect(popover()).toBeNull();

  await openAdvanced();
  expect(popover()).toBeTruthy();
  expect(advancedInput(en["dash.visionMaxDescriptions"])).toBeTruthy();
  expect(advancedInput(en["dash.visionTimeout"])).toBeTruthy();

  // Click outside closes.
  await act(async () => {
    testWindow.document.body.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true }));
  });
  expect(popover()).toBeNull();

  // Escape closes.
  await openAdvanced();
  expect(popover()).toBeTruthy();
  await act(async () => {
    testWindow.document.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(popover()).toBeNull();
});

test("opening the popover focuses its first input and Escape returns focus to the trigger", async () => {
  await mount(harness().d);
  const trigger = advancedTrigger();

  await openAdvanced();
  expect(testWindow.document.activeElement).toBe(advancedInput(en["dash.visionMaxDescriptions"]));

  await act(async () => {
    testWindow.document.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(popover()).toBeNull();
  expect(testWindow.document.activeElement).toBe(trigger);
});

test("clicking outside commits a dirty numeric input before closing the popover", async () => {
  const { d, patches } = harness();
  await mount(d);
  await openAdvanced();

  const maxInput = advancedInput(en["dash.visionMaxDescriptions"])!;
  maxInput.value = "9";

  await act(async () => {
    maxInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });

  expect(patches).toEqual([]);

  await act(async () => {
    testWindow.document.body.dispatchEvent(
      new testWindow.MouseEvent("mousedown", { bubbles: true }),
    );
  });

  expect(popover()).toBeNull();
  expect(patches).toEqual([
    { vision: { maxDescriptionsPerTurn: 9 } },
  ]);
});

test("reopening the Advanced popover preserves the server-backed values", async () => {
  const { d, patches } = harness();
  await mount(d);

  await openAdvanced();
  const maxInput = advancedInput(en["dash.visionMaxDescriptions"])!;
  maxInput.value = "9";
  await act(async () => { maxInput.dispatchEvent(new testWindow.Event("input", { bubbles: true })); });
  await act(async () => { maxInput.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(patches).toEqual([{ vision: { maxDescriptionsPerTurn: 9 } }]);

  // Close then reopen: the value reflects the saved server state.
  await act(async () => {
    testWindow.document.body.dispatchEvent(new testWindow.MouseEvent("mousedown", { bubbles: true }));
  });
  expect(popover()).toBeNull();
  await openAdvanced();
  expect(advancedInput(en["dash.visionMaxDescriptions"])?.value).toBe("9");
  expect(advancedInput(en["dash.visionTimeout"])?.value).toBe("30000");
});

test("timeout edit saves only timeoutMs", async () => {
  const { d, patches } = harness();
  await mount(d);
  await openAdvanced();

  const timeoutInput = advancedInput(en["dash.visionTimeout"])!;
  timeoutInput.value = "60000";
  await act(async () => { timeoutInput.dispatchEvent(new testWindow.Event("input", { bubbles: true })); });
  await act(async () => { timeoutInput.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(patches).toEqual([{ vision: { timeoutMs: 60_000 } }]);
});

test("Dashboard hydrates max descriptions, timeout, and the selected model from the server", async () => {
  await mount(harness().d);
  const card = visionCard();
  // enabled:true renders the actual selected model, not Off.
  expect(modelTrigger().textContent).toContain("gpt-5.6-luna");
  // No standalone Vision switch remains in the DOM.
  expect([...card.querySelectorAll("button.switch")]).toHaveLength(0);
  // Advanced numeric controls are hidden behind the trigger until opened.
  expect(advancedInput(en["dash.visionMaxDescriptions"])).toBeNull();
  expect(advancedInput(en["dash.visionTimeout"])).toBeNull();

  await openAdvanced();
  expect(advancedInput(en["dash.visionMaxDescriptions"])?.value).toBe("12");
  expect(advancedInput(en["dash.visionTimeout"])?.value).toBe("30000");
});

test("enabled:false hydrates the model control as Off", async () => {
  const { d } = harness({ ...initialSidecar, vision: { ...initialSidecar.vision, enabled: false } });
  await mount(d);
  expect(modelTrigger().textContent).toContain(en["dash.visionOff"]);
});

test("choosing Off sends only enabled:false and keeps the other Vision fields", async () => {
  const { d, patches, getSidecar } = harness();
  await mount(d);
  await act(async () => { modelTrigger().click(); });
  const off = pickOption(en["dash.visionOff"]);
  expect(off).toBeTruthy();
  await act(async () => { off!.click(); });
  expect(patches).toEqual([{ vision: { enabled: false } }]);
  expect(getSidecar().vision).toMatchObject({
    enabled: false,
    model: "gpt-5.6-luna",
    backend: "openai",
    reasoning: "medium",
    maxDescriptionsPerTurn: 12,
    timeoutMs: 30_000,
  });
});

test("choosing a model from Off sends enabled:true plus that model and backend", async () => {
  const { d, patches } = harness({ ...initialSidecar, vision: { ...initialSidecar.vision, enabled: false } });
  await mount(d);
  await act(async () => { modelTrigger().click(); });
  const next = pickOption("gpt-5.4-mini");
  expect(next).toBeTruthy();
  await act(async () => { next!.click(); });
  expect(patches).toEqual([
    { vision: { model: "gpt-5.4-mini", backend: "openai", reasoning: "medium", enabled: true } },
  ]);
});

test("no standalone Vision switch remains in the DOM", async () => {
  await mount(harness().d);
  expect([...visionCard().querySelectorAll("button.switch")]).toHaveLength(0);
});

test("editing the limit or timeout saves only that field", async () => {
  const { d, patches } = harness();
  await mount(d);
  await openAdvanced();

  const maxInput = advancedInput(en["dash.visionMaxDescriptions"])!;
  maxInput.value = "11";
  await act(async () => { maxInput.dispatchEvent(new testWindow.Event("input", { bubbles: true })); });
  await act(async () => { maxInput.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(patches).toEqual([{ vision: { maxDescriptionsPerTurn: 11 } }]);

  const timeoutInput = advancedInput(en["dash.visionTimeout"])!;
  timeoutInput.value = "31000";
  await act(async () => { timeoutInput.dispatchEvent(new testWindow.Event("input", { bubbles: true })); });
  await act(async () => { timeoutInput.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(patches[1]).toEqual({ vision: { timeoutMs: 31_000 } });
});

test("an unrelated web-search save does not include Vision fields", async () => {
  const { d, patches } = harness();
  await mount(d);
  const streamToggle = [...host.querySelectorAll("button.switch")].find(button =>
    button.getAttribute("aria-label") === en["dash.webSearchStream"],
  ) as HTMLButtonElement;
  await act(async () => { streamToggle.click(); });
  expect(patches).toEqual([{ webSearch: { streamRoutedModelOutput: true } }]);
});

function pickOption(label: string): HappyHTMLButtonElement | undefined {
  return [...testWindow.document.querySelectorAll('[role="option"]')]
    .find(option => option.textContent === label) as HappyHTMLButtonElement | undefined;
}

function assertVisionControlFieldsOmitted(patch: SidecarPatch) {
  expect(patch.vision).toBeDefined();
  expect(patch.vision).not.toHaveProperty("enabled");
  expect(patch.vision).not.toHaveProperty("maxDescriptionsPerTurn");
  expect(patch.vision).not.toHaveProperty("timeoutMs");
}

test("model and reasoning saves still omit enabled, limit, and timeout", async () => {
  const { d, patches } = harness();
  await mount(d);
  const card = visionCard();
  const modelTrigger = card.querySelector(
    `button[role="combobox"][aria-label="${en["dash.sidecarModel"]}"]`,
  ) as HTMLButtonElement;
  const reasoningTrigger = card.querySelector(
    `button[role="combobox"][aria-label="${en["dash.visionSidecar"]} — ${en["dash.injectionEffortLabel"]}"]`,
  ) as HTMLButtonElement;

  await act(async () => { modelTrigger.click(); });
  const nextModel = pickOption("gpt-5.4-mini");
  expect(nextModel).toBeTruthy();
  await act(async () => { nextModel!.click(); });
  expect(patches).toHaveLength(1);
  expect(patches[0]).toEqual({
    vision: { model: "gpt-5.4-mini", backend: "openai", reasoning: "medium" },
  });
  assertVisionControlFieldsOmitted(patches[0]!);

  await act(async () => { reasoningTrigger.click(); });
  const nextReasoning = pickOption("high");
  expect(nextReasoning).toBeTruthy();
  await act(async () => { nextReasoning!.click(); });
  expect(patches).toHaveLength(2);
  expect(patches[1]).toEqual({ vision: { reasoning: "high" } });
  assertVisionControlFieldsOmitted(patches[1]!);
});