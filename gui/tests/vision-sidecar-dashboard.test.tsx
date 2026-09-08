import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  Window,
  type HTMLButtonElement as HappyHTMLButtonElement,
  type HTMLElement as HappyHTMLElement,
  type HTMLInputElement as HappyHTMLInputElement,
} from "happy-dom";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { DashboardSidecarPanels } from "../src/pages/dashboard-overview-sections";
import type { SettingsData, SidecarData, SidecarPatch } from "../src/pages/dashboard-shared";
import { mergeSidecarSetting } from "../src/pages/dashboard-shared";
import { useDashboardData } from "../src/pages/use-dashboard-data";
import { clearClientResourceStoresForTests, setClientResourceData } from "../src/client-resource";
import { readSessionListCache } from "../src/session-list-cache";

const globals = ["document", "window", "navigator", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
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
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
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

test("Desktop login switch defaults off, preserves explicit opt-in, and disables while saving", async () => {
  const { d } = harness();
  let clicks = 0;
  d.toggleCodexDesktopAuthless = async () => { clicks += 1; };
  d.settings = { codexAutoStart: true, port: 10100, hostname: "127.0.0.1" };
  await mount(d);
  const toggle = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${en["dash.codexDesktopAuthless"]}"]`)!;
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  d.settings.codexDesktopAuthless = true;
  await mount(d);
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  await act(async () => { toggle().click(); });
  expect(clicks).toBe(1);
  d.settings.codexDesktopAuthless = false;
  d.settings.catalogRefreshPending = true;
  d.settingsSaving = true;
  await mount(d);
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(toggle().disabled).toBe(true);
  expect(host.textContent).toContain(en["codexAuth.catalogRefreshPending"]);
});


test.each([undefined, false, true])("Desktop login preference %s persists before full sync; sync failure keeps the saved preference", async (initial) => {
  const originalFetch = globalThis.fetch;
  const writes: Array<{ path: string; body: unknown }> = [];
  let latest: Dash | undefined;
  let saved = initial;
  const apiBase = `/authless-test-${String(initial)}`;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (body.codexDesktopAuthless !== undefined) {
        saved = body.codexDesktopAuthless;
        return Response.json({ codexDesktopAuthless: saved, catalogRefreshPending: true });
      }
      return Response.json({ codexAutoStart: body.codexAutoStart, catalogRefreshPending: false });
    }
    if (path.endsWith("/api/sync")) {
      writes.push({ path, body: null });
      return Response.json({ error: "sync unavailable" }, { status: 503 });
    }
    if (path.endsWith("/api/settings")) {
      return Response.json({ codexAutoStart: true, codexDesktopAuthless: saved, port: 10100, hostname: "127.0.0.1" });
    }
    return Response.json({}, { status: 503 });
  }) as typeof fetch;
  function Harness() {
    const data = useDashboardData(apiBase);
    useEffect(() => { latest = data; }, [data]);
    return null;
  }
  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(host);
      root.render(<LanguageProvider><Harness /></LanguageProvider>);
    });
    expect(latest?.settings?.codexDesktopAuthless).toBe(initial);
    await act(async () => { await latest!.toggleCodexDesktopAuthless(); });
    expect(writes).toEqual([
      { path: `${apiBase}/api/settings`, body: { codexDesktopAuthless: !initial } },
      { path: `${apiBase}/api/sync`, body: null },
    ]);
    expect(latest?.settings?.codexDesktopAuthless).toBe(!initial);
    expect(latest?.syncError).toBe("sync unavailable");
    expect(latest?.settings?.catalogRefreshPending).toBe(true);
    await act(async () => { await latest!.toggleCodexAutoStart(); });
    expect(latest?.settings?.codexAutoStart).toBe(false);
    expect(latest?.settings?.catalogRefreshPending).toBe(true);
  } finally {
    await act(async () => { root?.unmount(); });
    root = null;
    globalThis.fetch = originalFetch;
  }
});


test.each(["skipped", "catalog-only", "applied"])("Desktop preference pending state follows %s sync application evidence", async (syncStatus) => {
  const originalFetch = globalThis.fetch;
  let latest: Dash | undefined;
  const apiBase = `/authless-sync-${syncStatus}`;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "PUT") return Response.json({ codexDesktopAuthless: true, catalogRefreshPending: true });
    if (path.endsWith("/api/sync")) return Response.json({ ok: true, status: syncStatus, message: syncStatus });
    if (path.endsWith("/api/settings")) return Response.json({ codexAutoStart: true, codexDesktopAuthless: false, port: 10100, hostname: "127.0.0.1" });
    return Response.json({}, { status: 503 });
  }) as typeof fetch;
  function Harness() {
    const data = useDashboardData(apiBase);
    useEffect(() => { latest = data; }, [data]);
    return null;
  }
  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => { root = createRoot(host); root.render(<LanguageProvider><Harness /></LanguageProvider>); });
    await act(async () => { await latest!.toggleCodexDesktopAuthless(); });
    expect(latest?.settings?.codexDesktopAuthless).toBe(true);
    expect(latest?.settings?.catalogRefreshPending).toBe(syncStatus !== "applied");
    expect(latest?.syncResult?.status).toBe(syncStatus);
    // A fresh settings poll has no application receipt and cannot erase pending.
    await act(async () => {
      setClientResourceData(`dashboard-settings:${apiBase}`, {
        settings: { codexAutoStart: true, codexDesktopAuthless: true, port: 10100, hostname: "127.0.0.1" },
      });
    });
    expect(latest?.settings?.codexDesktopAuthless).toBe(true);
    expect(latest?.settings?.catalogRefreshPending === true).toBe(syncStatus !== "applied");
  } finally {
    await act(async () => { root?.unmount(); });
    root = null;
    globalThis.fetch = originalFetch;
  }
});

for (const putPending of [false, undefined, true]) {
  test.each([
    { name: "HTTP failure", body: { error: "sync unavailable" }, status: 503 },
    { name: "skipped", body: { ok: true, status: "skipped" }, status: 200 },
    { name: "catalog-only", body: { ok: true, status: "catalog-only" }, status: 200 },
    { name: "unsuccessful applied", body: { ok: false, status: "applied" }, status: 200 },
    { name: "absent status", body: { ok: true }, status: 200 },
    { name: "absent ok", body: { status: "applied" }, status: 200 },
  ])(`Desktop saved preference stays pending with PUT ${String(putPending)} and $name sync`, async ({ body, status }) => {
    const originalFetch = globalThis.fetch;
    const apiBase = `/authless-pending-${String(putPending)}-${status}-${JSON.stringify(body)}`;
    let latest: Dash | undefined;
    let saved = false;
    let apply = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/settings")) {
        if (init?.method === "PUT") {
          saved = JSON.parse(String(init.body)).codexDesktopAuthless;
          return Response.json({ codexDesktopAuthless: saved, catalogRefreshPending: putPending });
        }
        return Response.json({ codexAutoStart: true, codexDesktopAuthless: saved, port: 10100, hostname: "127.0.0.1" });
      }
      if (path.endsWith("/api/sync")) {
        return apply ? Response.json({ ok: true, status: "applied" }) : Response.json(body, { status });
      }
      return Response.json({}, { status: 503 });
    }) as typeof fetch;
    function Harness() {
      const data = useDashboardData(apiBase);
      useEffect(() => { latest = data; }, [data]);
      return null;
    }
    const { createRoot } = await import("react-dom/client");
    const render = async () => {
      await act(async () => { root = createRoot(host); root.render(<LanguageProvider><Harness /></LanguageProvider>); });
    };
    const remount = async () => {
      await act(async () => { root?.unmount(); });
      root = null;
      clearClientResourceStoresForTests();
      await render();
    };
    const cachedSettings = () => readSessionListCache<{ settings: SettingsData }>(`ocx.dash.controls.v1:${apiBase}`)?.settings;
    try {
      await render();
      expect(latest?.settings?.catalogRefreshPending).toBeUndefined();
      await act(async () => { await latest!.toggleCodexDesktopAuthless(); });
      expect(latest?.settings?.codexDesktopAuthless).toBe(true);
      expect(latest?.settings?.catalogRefreshPending).toBe(true);
      expect(latest?.syncError).toBe(status === 503 ? "sync unavailable" : null);
      expect(latest?.syncResult).toEqual(status === 503 ? null : body);
      expect(cachedSettings()?.codexDesktopAuthless).toBe(true);
      expect(cachedSettings()?.catalogRefreshPending).toBe(true);
      // Real GETs on remount omit receipts; neither live state nor its cache may lose pending.
      await remount();
      expect(latest?.settings?.catalogRefreshPending).toBe(true);
      expect(cachedSettings()?.catalogRefreshPending).toBe(true);
      await remount();
      expect(latest?.settings?.catalogRefreshPending).toBe(true);
      apply = true;
      await act(async () => { await latest!.runSync(); });
      expect(latest?.settings?.catalogRefreshPending).toBe(false);
      expect(cachedSettings()?.catalogRefreshPending).toBe(false);
      expect(latest?.syncError).toBeNull();
      expect(latest?.syncResult).toEqual({ ok: true, status: "applied" });
      await remount();
      expect(latest?.settings?.catalogRefreshPending === true).toBe(false);
      expect(cachedSettings()?.catalogRefreshPending === true).toBe(false);
    } finally {
      await act(async () => { root?.unmount(); });
      root = null;
      clearClientResourceStoresForTests();
      globalThis.fetch = originalFetch;
    }
  });
}

test.each([undefined, false])("Desktop GET pending %s preserves a cached pending receipt across repeated remounts", async (getPending) => {
  const originalFetch = globalThis.fetch;
  const apiBase = `/authless-cache-${String(getPending)}`;
  let latest: Dash | undefined;
  const cacheKey = `ocx.dash.controls.v1:${apiBase}`;
  testWindow.sessionStorage.setItem(cacheKey, JSON.stringify({
    settings: { codexAutoStart: true, codexDesktopAuthless: true, catalogRefreshPending: true, port: 10100, hostname: "127.0.0.1" },
  }));
  globalThis.fetch = (async (input: RequestInfo | URL) => String(input).endsWith("/api/settings")
    ? Response.json({ codexAutoStart: true, codexDesktopAuthless: true, catalogRefreshPending: getPending, port: 10100, hostname: "127.0.0.1" })
    : Response.json({}, { status: 503 })) as typeof fetch;
  function Harness() {
    const data = useDashboardData(apiBase);
    useEffect(() => { latest = data; }, [data]);
    return null;
  }
  try {
    const { createRoot } = await import("react-dom/client");
    for (let visit = 0; visit < 2; visit += 1) {
      await act(async () => { root = createRoot(host); root.render(<LanguageProvider><Harness /></LanguageProvider>); });
      expect(latest?.settings?.catalogRefreshPending).toBe(true);
      expect(readSessionListCache<{ settings: SettingsData }>(cacheKey)?.settings.catalogRefreshPending).toBe(true);
      await act(async () => { root?.unmount(); });
      root = null;
      clearClientResourceStoresForTests();
    }
  } finally {
    await act(async () => { root?.unmount(); });
    root = null;
    clearClientResourceStoresForTests();
    globalThis.fetch = originalFetch;
  }
});

test.each([true, false])("Desktop settings retain an optimistic preference during polling and settle save success=%s", async (saveSucceeds) => {
  const originalFetch = globalThis.fetch;
  const apiBase = `/authless-optimistic-${saveSucceeds}`;
  let latest: Dash | undefined;
  let syncCalls = 0;
  const saveResponse = Promise.withResolvers<Response>();
  const initialSettings: SettingsData = { codexAutoStart: true, port: 10100, hostname: "127.0.0.1" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/settings")) {
      return init?.method === "PUT" ? saveResponse.promise : Response.json(initialSettings);
    }
    if (String(input).endsWith("/api/sync")) {
      syncCalls += 1;
      return Response.json({ ok: true, status: "skipped" });
    }
    return Response.json({}, { status: 503 });
  }) as typeof fetch;
  function Harness() {
    const data = useDashboardData(apiBase);
    useEffect(() => { latest = data; }, [data]);
    return null;
  }
  let save: Promise<void> | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => { root = createRoot(host); root.render(<LanguageProvider><Harness /></LanguageProvider>); });
    expect(latest?.settings?.codexDesktopAuthless).toBeUndefined();
    await act(async () => { save = latest!.toggleCodexDesktopAuthless(); });
    expect(latest?.settingsSaving).toBe(true);
    expect(latest?.settings?.codexDesktopAuthless).toBe(true);
    expect(latest?.settings?.catalogRefreshPending).toBeUndefined();
    // A published snapshot must not replace a mutation that has not settled yet.
    await act(async () => {
      setClientResourceData(`dashboard-settings:${apiBase}`, { settings: initialSettings });
    });
    expect(latest?.settingsSaving).toBe(true);
    expect(latest?.settings?.codexDesktopAuthless).toBe(true);
    await act(async () => {
      saveResponse.resolve(saveSucceeds
        ? Response.json({ codexDesktopAuthless: true, catalogRefreshPending: false })
        : Response.json({ error: "save unavailable" }, { status: 503 }));
      await save;
    });
    expect(latest?.settingsSaving).toBe(false);
    expect(latest?.settings?.codexDesktopAuthless).toBe(saveSucceeds ? true : undefined);
    expect(latest?.settings?.catalogRefreshPending).toBe(saveSucceeds ? true : undefined);
    expect(syncCalls).toBe(saveSucceeds ? 1 : 0);
    expect(readSessionListCache<{ settings: SettingsData }>(`ocx.dash.controls.v1:${apiBase}`)?.settings).toEqual(latest!.settings!);
    // A later, settled poll still updates unrelated settings and preserves any receipt.
    await act(async () => {
      setClientResourceData(`dashboard-settings:${apiBase}`, {
        settings: { ...initialSettings, codexDesktopAuthless: saveSucceeds ? true : undefined, port: 10200 },
      });
    });
    expect(latest?.settings?.port).toBe(10200);
    expect(latest?.settings?.catalogRefreshPending).toBe(saveSucceeds ? true : undefined);
  } finally {
    await act(async () => {
      saveResponse.resolve(Response.json({ error: "test cleanup" }, { status: 503 }));
      await save;
      root?.unmount();
    });
    root = null;
    clearClientResourceStoresForTests();
    globalThis.fetch = originalFetch;
  }
});
