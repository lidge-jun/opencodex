import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { DashboardSidecarPanels } from "../src/pages/dashboard-overview-sections";
import { ClaudeCodeSettingsCard } from "../src/pages/claude-code-sections";
import { claudeCodeSaveBody } from "../src/pages/claude-code-save";
import type { ClaudeCodeState } from "../src/pages/claude-code-types";
import { mergeSidecarSetting, sidecarPatchForSave, type SidecarData, type SidecarPatch } from "../src/pages/dashboard-shared";
import type { useDashboardData } from "../src/pages/use-dashboard-data";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document }, window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator }, localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true },
  });
  host = document.createElement("div"); document.body.append(host);
});
afterEach(async () => {
  try { if (root) await act(async () => { root!.unmount(); }); }
  finally {
    root = undefined; testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
async function mount(element: ReactNode) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root = createRoot(host); root.render(<LanguageProvider>{element}</LanguageProvider>); });
}
async function pick(trigger: HTMLButtonElement, label: string) {
  await act(async () => { trigger.click(); });
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === label);
  expect(option).toBeTruthy();
  await act(async () => { option!.click(); });
}
function pools() {
  return [...host.querySelectorAll<HTMLButtonElement>(`button[role="combobox"][aria-label="${en["sidecar.pool"]}"]`)];
}
const sidecars: SidecarData = {
  webSearch: { backend: "anthropic", model: "claude-haiku-4-5" },
  vision: { backend: "anthropic", model: "claude-haiku-4-5", reasoning: "low" },
};

test("global web-search and vision pool controls submit B and explicit deletion; other settings survive", async () => {
  const patches: SidecarPatch[] = [];
  let current = sidecars;
  function Harness() {
    const [state, setState] = useState(sidecars);
    const d = {
      t: (key: keyof typeof en) => en[key], settings: null, settingsSaving: false,
      sidecar: state, sidecarSaving: false, models: [],
      sidecarModels: [{ value: "claude-haiku-4-5", label: "claude-haiku-4-5", backend: "anthropic" }],
      visionModels: [{ value: "claude-haiku-4-5", label: "claude-haiku-4-5", backend: "anthropic" }],
      saveSidecar: async (patch: SidecarPatch) => {
        patches.push(patch); current = { webSearch: mergeSidecarSetting(state.webSearch, patch.webSearch), vision: mergeSidecarSetting(state.vision, patch.vision) };
        setState(current);
      },
      shadowCall: null, shadowCallSaving: false, shadowCallHelpTriggerRef: { current: null },
      shadowCallHelpOpen: false, setShadowCallHelpOpen: () => {}, saveShadowCall: async () => {},
    } as unknown as ReturnType<typeof useDashboardData>;
    return <DashboardSidecarPanels d={d} />;
  }
  await mount(<Harness />);
  expect(pools()).toHaveLength(2);
  await pick(pools()[0]!, en["sidecar.poolB"]);
  await pick(pools()[1]!, en["sidecar.poolB"]);
  expect(patches).toEqual([{ webSearch: { anthropicInstance: "anthropic2" } }, { vision: { anthropicInstance: "anthropic2" } }]);
  expect(current.vision.model).toBe("claude-haiku-4-5");
  expect(current.vision.reasoning).toBe("low");
  await pick(pools()[0]!, en["sidecar.poolCurrent"]);
  expect(patches[2]).toEqual({ webSearch: { anthropicInstance: null } });
  expect(Object.hasOwn(current.webSearch, "anthropicInstance")).toBe(false);
  expect(sidecarPatchForSave(current, { vision: { backend: "openai", model: "gpt-5.6-luna" } }))
    .toEqual({ vision: { backend: "openai", model: "gpt-5.6-luna", anthropicInstance: null } });
});

const claude: ClaudeCodeState = {
  enabled: true, cliFirstParty: false, cliFirstPartyApplied: false, desktopFirstParty: false,
  interceptRunning: false, interceptEligible: true, sharedProxy: "none", authMode: "proxy", autoConnectSupported: false,
  systemEnv: false, fastMode: null, maxContextTokens: null, autoContext: true, autoCompactWindow: null,
  contextAccounting: "1m", injectAgents: true, smallFastModel: "", effectiveModelEnv: {}, available: [], aliases: [], port: 10100,
  webSearchSidecar: { backend: "anthropic" }, visionSidecar: { backend: "anthropic" },
  sidecarPools: { webSearchSidecar: { parent: "anthropic", mixed: false, available: ["anthropic", "anthropic2"] },
    visionSidecar: { parent: "anthropic", mixed: false, available: ["anthropic", "anthropic2"] } },
};
test("Claude draft derives mixed note immediately, keeps unset omitted, and clears pool on backend transition", async () => {
  let current = claude;
  function Harness() {
    const [state, setState] = useState(claude);
    useLayoutEffect(() => { current = state; }, [state]);
    return <ClaudeCodeSettingsCard state={state} availableModels={[]} autoCompactOptions={[]} onStateChange={setState} />;
  }
  await mount(<Harness />);
  expect(claudeCodeSaveBody(current, []).webSearchSidecar).toEqual({ backend: "anthropic", model: "" });
  await pick(pools()[0]!, en["sidecar.poolB"]);
  expect(host.textContent).toContain(en["sidecar.poolMixed"]);
  expect(claudeCodeSaveBody(current, []).webSearchSidecar?.anthropicInstance).toBe("anthropic2");
  await pick(pools()[0]!, en["sidecar.poolCurrent"]);
  expect(host.textContent).not.toContain(en["sidecar.poolMixed"]);
  expect(claudeCodeSaveBody(current, []).webSearchSidecar?.anthropicInstance).toBeNull();
  await pick(pools()[1]!, en["sidecar.poolB"]);
  const backend = host.querySelectorAll<HTMLButtonElement>(`button[role="combobox"][aria-label="${en["dash.sidecarBackend"]}"]`)[1]!;
  await pick(backend, en["dash.backendOpenAI"]);
  expect(pools()).toHaveLength(1);
  expect(claudeCodeSaveBody(current, []).visionSidecar).toEqual({ backend: "openai", model: "", anthropicInstance: null });
});

test("Claude inherits an Anthropic backend and can set only its pool without materializing a backend", async () => {
  const initial: ClaudeCodeState = { ...claude, webSearchSidecar: undefined, visionSidecar: undefined,
    sidecarPools: { webSearchSidecar: { backend: "anthropic", mixed: false, available: ["anthropic2"] },
      visionSidecar: { backend: "openai", mixed: false, available: ["anthropic2"] } },
  };
  let current = initial;
  function Harness() {
    const [state, setState] = useState(initial);
    useLayoutEffect(() => { current = state; }, [state]);
    return <ClaudeCodeSettingsCard state={state} availableModels={[]} autoCompactOptions={[]} onStateChange={setState} />;
  }
  await mount(<Harness />);
  expect(pools()).toHaveLength(1);
  await pick(pools()[0]!, en["sidecar.poolB"]);
  expect(claudeCodeSaveBody(current, []).webSearchSidecar)
    .toEqual({ backend: null, model: "", anthropicInstance: "anthropic2" });
});
