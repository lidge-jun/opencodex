import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ComboWorkspace from "../src/components/ComboWorkspace";
import { LanguageProvider } from "../src/i18n/provider";
import type { ComboItem } from "../src/combo-workspace-data";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let testWindow: Window;
let root: Root | null;

const models = [
  { provider: "openai", id: "gpt-6-astra", reasoningEfforts: ["medium", "high"] },
  { provider: "openai", id: "gpt-5.6-sol", reasoningEfforts: ["low", "medium"] },
  { provider: "openai", id: "gpt-5.6-luna", reasoningEfforts: ["low"] },
];
const providers = [
  { name: "openai", adapter: "openai-responses" },
  { name: "jev", adapter: "jev-decision", baseUrl: "https://api.typesafe.ai/v1/systemone", hiddenFromPicker: true },
  { name: "tev-local", adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone", defaultModel: "tev1:4b", hiddenFromPicker: true },
  { name: "tev-off", adapter: "jev-decision", baseUrl: "http://127.0.0.1:11435/v1/systemone", defaultModel: "tev1:4b", disabled: true, hiddenFromPicker: true },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  originalFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/#providers/tev-local" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function flush(rounds = 3) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  });
}

function setSelect(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
    .set!.call(select, value);
  select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
}

const levelCombo: ComboItem = {
  id: "tev-auto",
  model: "combo/tev-auto",
  alias: null,
  nativeAlias: false,
  displayName: null,
  strategy: "jev",
  stickyLimit: 1,
  defaultEffort: null,
  decisionProvider: "tev-local",
  decisionQuotaSignals: true,
  decisionMode: "level",
  decisionLevels: [
    { id: "trivial", candidates: [{ provider: "openai", model: "gpt-5.6-luna", effort: "low" }] },
    { id: "hard", candidates: [
      { provider: "openai", model: "gpt-5.6-sol", effort: "medium" },
      { provider: "openai", model: "gpt-6-astra" },
    ] },
  ],
  targets: [
    { provider: "openai", model: "gpt-6-astra", clientKey: "t1" },
    { provider: "openai", model: "gpt-5.6-sol", clientKey: "t2" },
    { provider: "openai", model: "gpt-5.6-luna", clientKey: "t3" },
  ],
};

async function renderWorkspace(combos: ComboItem[], saved: ComboItem[]) {
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <ComboWorkspace
          combos={combos}
          providerQuotaStates={{}}
          providers={providers}
          models={models}
          loading={false}
          onRefresh={() => {}}
          onSave={async (item) => { saved.push(item); return { ok: true }; }}
          onRemove={async () => ({ ok: true })}
          onAdd={() => {}}
          adding={false}
          onCloseAdd={() => {}}
          onCreated={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await flush();
  return host;
}

test("a routed level-mode combo names within-level routing on its overview chip", async () => {
  const host = await renderWorkspace([{ ...levelCombo, decisionLevelSelect: "route" }], []);
  const row = host.querySelector<HTMLButtonElement>('[data-decision-provider="tev-local"]')!;
  expect(row.querySelector('[data-decision-mode="level"]')?.textContent).toBe("Level mode · Route target and effort");
});

test("a level-mode combo shows its mode, a read-only level summary, and the fallback level", async () => {
  const host = await renderWorkspace([levelCombo], []);
  const row = host.querySelector<HTMLButtonElement>('[data-decision-provider="tev-local"]')!;
  expect(row.querySelector('[data-decision-mode="level"]')?.textContent).toBe("Level mode");
  await act(async () => { row.click(); });
  await flush();

  const mode = host.querySelector<HTMLSelectElement>("#cwi-edit-decision-mode")!;
  expect(mode.value).toBe("level");
  expect(host.querySelector('label[for="cwi-edit-decision-mode"]')?.textContent).toBe("Decision mode");
  expect(mode.getAttribute("aria-describedby")).toBe("cwi-edit-decision-mode-hint");
  const summary = host.querySelector("[data-jev-levels]")!;
  expect([...summary.querySelectorAll("[data-level]")].map(item => item.getAttribute("data-level"))).toEqual(["trivial", "hard"]);
  expect(summary.querySelector('[data-level="hard"]')?.textContent).toContain("openai/gpt-5.6-sol:medium");
  expect(summary.querySelector('[data-level="hard"]')?.textContent).toContain("openai/gpt-6-astra");
  expect(summary.querySelector("[data-fallback-level]")?.textContent).toBe("Fallback level: routine");
  // No editing controls for levels themselves.
  expect(summary.querySelectorAll("input, select, textarea")).toHaveLength(0);
  expect(host.querySelector("#cwi-edit-decision-quota-hint")?.textContent).toContain("No quota is sent to the decision service");
});

test("switching to route mode saves only the mode and keeps the stored levels on the item", async () => {
  const saved: ComboItem[] = [];
  const host = await renderWorkspace([levelCombo], saved);
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-decision-provider="tev-local"]')!.click(); });
  await flush();
  const mode = host.querySelector<HTMLSelectElement>("#cwi-edit-decision-mode")!;
  await act(async () => { setSelect(mode, "route"); });
  expect(host.querySelector("[data-jev-levels]")).toBeNull();
  expect(host.querySelector("#cwi-edit-decision-quota-hint")?.textContent).toContain("nearly exhausted");
  await act(async () => { host.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
  await flush();
  expect(saved.at(-1)?.decisionMode).toBeUndefined();
  expect(saved.at(-1)?.decisionLevels).toEqual(levelCombo.decisionLevels);
});

test("level mode cannot be picked without stored levels", async () => {
  const { decisionMode: _mode, decisionLevels: _levels, ...routeCombo } = levelCombo;
  const host = await renderWorkspace([routeCombo], []);
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-decision-provider="tev-local"]')!.click(); });
  await flush();
  const mode = host.querySelector<HTMLSelectElement>("#cwi-edit-decision-mode")!;
  expect(mode.value).toBe("route");
  expect(mode.querySelector<HTMLOptionElement>('option[value="level"]')!.disabled).toBe(true);
  expect(host.querySelector("#cwi-edit-decision-mode-hint")?.textContent).toContain("needs decision levels");
  expect(host.querySelector('[data-decision-mode="level"]')).toBeNull();
});

test("stale level candidates show the fix before Save, and route mode can clear the levels", async () => {
  const saved: ComboItem[] = [];
  // The luna target is gone, and sol no longer allows the medium effort a level names.
  const staleCombo: ComboItem = {
    ...levelCombo,
    targets: [
      { provider: "openai", model: "gpt-6-astra", clientKey: "t1" },
      { provider: "openai", model: "gpt-5.6-sol", clientKey: "t2", reasoningEfforts: ["low"] },
    ],
  };
  const host = await renderWorkspace([staleCombo], saved);
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-decision-provider="tev-local"]')!.click(); });
  await flush();

  const warning = host.querySelector("[data-jev-levels-stale]")!;
  expect(warning.getAttribute("role")).toBe("alert");
  expect(warning.textContent).toContain("openai/gpt-5.6-luna:low, openai/gpt-5.6-sol:medium");
  expect(warning.querySelector("code")?.textContent).toBe("ocx combo set tev-auto --decision-levels '<json>'");
  // Clearing is offered only in route mode.
  expect(host.querySelector("[data-jev-levels-clear]")).toBeNull();

  await act(async () => { setSelect(host.querySelector<HTMLSelectElement>("#cwi-edit-decision-mode")!, "route"); });
  const clear = host.querySelector<HTMLButtonElement>("[data-jev-levels-clear]")!;
  expect(clear.textContent).toBe("Clear stored levels");
  await act(async () => { clear.click(); });
  expect(host.querySelector("[data-jev-levels-stale]")).toBeNull();
  expect(host.querySelector("[data-jev-levels-cleared]")).not.toBeNull();
  expect(host.querySelector<HTMLOptionElement>('#cwi-edit-decision-mode option[value="level"]')!.disabled).toBe(true);

  await act(async () => { host.querySelector<HTMLButtonElement>("#cwi-edit-save")!.click(); });
  await flush();
  const last = saved.at(-1)!;
  expect(last.clearDecisionLevels).toBe(true);
  expect(last.decisionLevels).toBeUndefined();
});

test("leaving the JEV strategy warns that stored levels will be discarded", async () => {
  const host = await renderWorkspace([levelCombo], []);
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-decision-provider="tev-local"]')!.click(); });
  await flush();
  expect(host.querySelector("[data-jev-levels-discard]")).toBeNull();
  const failover = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find(candidate => candidate.textContent?.trim() === "Failover")!;
  await act(async () => { failover.click(); });
  const warning = host.querySelector("[data-jev-levels-discard]")!;
  expect(warning.getAttribute("role")).toBe("alert");
  expect(warning.textContent).toContain("permanently removes");
});

test("within-level selector enables routing and mode switches clear it without editing levels", async () => {
  const saved: ComboItem[] = [];
  const host = await renderWorkspace([levelCombo], saved);
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-decision-provider="tev-local"]')!.click(); });
  await flush();
  const selector = host.querySelector<HTMLSelectElement>("#cwi-edit-level-select")!;
  expect(selector.value).toBe("order");
  expect(host.querySelector('label[for="cwi-edit-level-select"]')?.textContent).toBe("Within-level selection");
  expect(host.querySelector("#cwi-edit-level-select-hint")?.textContent).toContain("share one deadline");
  await act(async () => { setSelect(selector, "route"); });
  await flush();
  expect(host.querySelector("#cwi-edit-decision-quota-hint")?.textContent).not.toContain("No quota is sent");
  const save = host.querySelector<HTMLButtonElement>("#cwi-edit-save")!;
  await act(async () => { save.click(); });
  await flush();
  expect(saved[0]?.decisionLevelSelect).toBe("route");
  expect(saved[0]?.decisionLevels).toEqual(levelCombo.decisionLevels);
  await act(async () => { setSelect(host.querySelector<HTMLSelectElement>("#cwi-edit-decision-mode")!, "route"); });
  await flush();
  expect(host.querySelector("#cwi-edit-level-select")).toBeNull();
  await act(async () => { setSelect(host.querySelector<HTMLSelectElement>("#cwi-edit-decision-mode")!, "level"); });
  await flush();
  expect(host.querySelector<HTMLSelectElement>("#cwi-edit-level-select")!.value).toBe("order");
});
