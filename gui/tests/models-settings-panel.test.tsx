import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelsSettingsPanel } from "../src/pages/models-settings-panel";
import { SETTINGS_OPEN_KEY, modelsSettingsSummary } from "../src/pages/models-settings-summary";
import type { TFn } from "../src/i18n/shared";

/**
 * The Models settings panel folds every global catalog control. Two properties matter:
 * folding never hides state (the summary names each value), and only a user toggle is
 * remembered — a warning that forces the panel open must not become a stored preference.
 */

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const t = ((key: string) => key) as unknown as TFn;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as unknown as Node);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previousGlobals[key] });
  testWindow.close();
});

function render(props: { warn: boolean; storage: MemoryStorage }) {
  root ??= createRoot(container);
  act(() => root!.render(
    <ModelsSettingsPanel title="Model settings" attentionLabel="Needs attention" warn={props.warn} storage={props.storage}
      summary={[{ id: "subagent", label: "Sub-agent", value: "v1" }, { id: "shadow", label: "Shadow", value: "off" }]}>
      <button type="button">inner control</button>
    </ModelsSettingsPanel>,
  ));
  return container.querySelector("details") as HTMLDetailsElement;
}

/** What the browser does on a summary click: flip open, then fire the non-bubbling toggle. */
function userToggle(details: HTMLDetailsElement) {
  act(() => {
    details.open = !details.open;
    details.dispatchEvent(new testWindow.Event("toggle") as unknown as Event);
  });
}

test("summary lists sub-agent, shadow, window and order in that order; new-model policy only when off", () => {
  const base = { multiAgentMode: "v1" as const, shadowEnabled: true, shadowModel: "xai/grok-4.5", windowOn: false, windowValue: 350_000, pickerMode: "most-used", newModelsOff: false, aliasesOn: false };
  expect(modelsSettingsSummary(t, base).map(item => [item.id, item.value])).toEqual([
    ["subagent", "models.v2Mode_v1"],
    ["shadow", "xai/grok-4.5"],
    ["window", "models.settingsPanel.off"],
    ["order", "models.pickerOrder.mostUsed"],
  ]);
  const off = modelsSettingsSummary(t, { ...base, shadowEnabled: false, windowOn: true, newModelsOff: true });
  expect(off.find(item => item.id === "shadow")?.value).toBe("models.settingsPanel.off");
  expect(off.find(item => item.id === "window")?.value).toBe("350k");
  expect(off.at(-1)?.id).toBe("new-models");
  // While the v2 settings are still loading there is no truthful mode to show.
  expect(modelsSettingsSummary(t, { ...base, multiAgentMode: undefined })[0]?.id).toBe("shadow");
  // Non-default folded controls surface too; the thread cap and keep-native only mean anything on v2.
  const v2 = modelsSettingsSummary(t, { ...base, multiAgentMode: "v2", v2Threads: 8, keepNativeOnV1: true, aliasesOn: true });
  expect(v2.map(item => item.id)).toEqual(["subagent", "threads", "keep-native", "shadow", "window", "order", "aliases"]);
  expect(v2.find(item => item.id === "threads")?.value).toBe("8");
  expect(modelsSettingsSummary(t, { ...base, v2Threads: 8, keepNativeOnV1: true }).map(item => item.id))
    .toEqual(["subagent", "shadow", "window", "order"]);
});

test("starts folded, and a user toggle is remembered under its own key", () => {
  const storage = new MemoryStorage();
  const details = render({ warn: false, storage });
  expect(details.open).toBe(false);
  expect(container.querySelector(".models-settings-state")?.textContent).toContain("Sub-agent");

  userToggle(details);
  expect(details.open).toBe(true);
  expect(storage.getItem(SETTINGS_OPEN_KEY)).toBe("1");
  expect(storage.values.has("ocx-models-collapsed:v2")).toBe(false);

  userToggle(details);
  expect(storage.getItem(SETTINGS_OPEN_KEY)).toBe("0");
});

test("a warning opens the panel without writing a preference; closing it dismisses the force", () => {
  const storage = new MemoryStorage();
  let details = render({ warn: false, storage });
  expect(details.open).toBe(false);

  details = render({ warn: true, storage });
  expect(details.open).toBe(true);
  expect(container.querySelector(".models-settings-warn")?.getAttribute("aria-label")).toBe("Needs attention");
  // React's own attribute write is followed by a toggle event; it must not count as the user's.
  act(() => { details.dispatchEvent(new testWindow.Event("toggle") as unknown as Event); });
  expect(storage.getItem(SETTINGS_OPEN_KEY)).toBeNull();

  userToggle(details);
  expect(details.open).toBe(false);
  expect(storage.getItem(SETTINGS_OPEN_KEY)).toBe("0");
});

test("a stored open preference is restored on mount", () => {
  const storage = new MemoryStorage();
  storage.setItem(SETTINGS_OPEN_KEY, "1");
  expect(render({ warn: false, storage }).open).toBe(true);
});
