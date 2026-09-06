import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";

const globals = [
  "document", "window", "navigator", "localStorage", "sessionStorage",
  "IS_REACT_ACT_ENVIRONMENT", "setInterval", "clearInterval",
  "setTimeout", "clearTimeout", "fetch",
] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

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
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    setInterval: { configurable: true, value: () => 1 },
    clearInterval: { configurable: true, value: () => {} },
  });
  testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));
  testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
    models: [
      { provider: "anthropic", id: "claude-sonnet-5", namespaced: "anthropic/claude-sonnet-5", disabled: false },
      { provider: "anthropic", id: "claude-opus-4-5", namespaced: "anthropic/claude-opus-4-5", disabled: false },
    ],
    providers: [{ name: "anthropic", liveModels: true, models: ["claude-sonnet-5", "claude-opus-4-5"] }],
    selectedModels: {},
    disabled: [],
    contextCaps: {},
    contextCapValue: 350_000,
  }));
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/subagent-models") && init?.method !== "PUT") {
      return Response.json({ pickerAvailable: ["anthropic/claude-sonnet-5", "anthropic/claude-opus-4-5"], pickerOrder: [], pickerOrderMode: null });
    }
    if (url.endsWith("/api/models")) {
      return Response.json([
        { provider: "anthropic", id: "claude-sonnet-5", namespaced: "anthropic/claude-sonnet-5", disabled: false },
        { provider: "anthropic", id: "claude-opus-4-5", namespaced: "anthropic/claude-opus-4-5", disabled: false },
      ]);
    }
    if (url.endsWith("/api/providers")) return Response.json([{ name: "anthropic", liveModels: true, models: ["claude-sonnet-5", "claude-opus-4-5"] }]);
    if (url.endsWith("/api/selected-models")) return Response.json({ selected: {} });
    if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
    if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
    if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
    if (url.endsWith("/api/v2")) return Response.json({ enabled: false, agentsMaxThreadsConflict: false, multiAgentMode: "default" });
    if (url.endsWith("/api/model-visibility") && init?.method === "PUT") return Response.json({ ok: true });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  clearClientResourceStoresForTests();
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

// Controlled global timers: the toast hold timer runs through the real global setTimeout
// (the component calls it bare), so tests can advance time deterministically instead of
// waiting 6-8 real seconds. clearTimeout is a no-op here — stale timers are filtered out
// by the hold duration when fired.
let scheduledTimers: Array<{ fn: () => void; ms: number }> = [];
function installFakeTimers() {
  scheduledTimers = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    scheduledTimers.push({ fn, ms: ms ?? 0 });
    return scheduledTimers.length;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
}
async function fireTimers(ms: number) {
  const due = scheduledTimers.filter(t => t.ms === ms);
  scheduledTimers = scheduledTimers.filter(t => t.ms !== ms);
  await act(async () => { for (const t of due) t.fn(); });
}

test("apply feedback renders as a fixed toast, not an inline notice before the workspace", async () => {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Models apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });

  // Hide the whole provider group, the same action that used to pop the inline notice.
  await act(async () => {
    const off = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "All off")!;
    off.click();
    await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });

  const toast = container.querySelector<HTMLElement>(".action-toast");
  expect(toast).not.toBeNull();
  expect(toast!.className).toContain("notice-ok");
  expect(toast!.getAttribute("role")).toBe("status");
  expect(toast!.textContent).toContain("Applied");
  // No inline notice sits in the flow before the workspace anymore.
  const workspace = container.querySelector<HTMLElement>(".models-workspace-root");
  expect(workspace?.previousElementSibling?.classList.contains("action-toast")).toBe(true);
});

test("success toast expires after 6s and a repeated action re-arms it", async () => {
  installFakeTimers();
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Models apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });

  const offButton = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "All off")!;
  const clickOff = async () => {
    await act(async () => {
      offButton().click();
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
  };

  // First action: toast appears with a 6s hold timer.
  await clickOff();
  expect(container.querySelector(".action-toast")).not.toBeNull();

  // 6s elapse: auto-dismissed even though no new action happened.
  await fireTimers(6000);
  expect(container.querySelector(".action-toast")).toBeNull();

  // The exact same action again: the toast re-arms (fresh 6s hold) instead of
  // staying dismissed because the message value did not change.
  await clickOff();
  expect(container.querySelector(".action-toast")).not.toBeNull();
  await fireTimers(6000);
  expect(container.querySelector(".action-toast")).toBeNull();
});

test("OpenAI context switch restores the selected cap after a disabled-page reload instead of forcing 922k", async () => {
  testWindow.sessionStorage.clear();
  let caps: Record<string, number> = {openai:128_000};
  const values = {openai:128_000};
  const bodies: unknown[] = [];
  let capReads = 0;
  const fallback = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/models")) return Response.json([
      {provider:"openai",id:"gpt-5.5",namespaced:"gpt-5.5",native:true,disabled:false,contextWindow:caps.openai??272_000},
    ]);
    if (url.endsWith("/api/providers")) return Response.json([{name:"openai",authMode:"forward",liveModels:false}]);
    if (url.endsWith("/api/provider-context-caps")) {
      if (init?.method === "PUT") {
        const body=JSON.parse(String(init.body)); bodies.push(body);
        caps=body.enabled ? {openai:values.openai} : {};
      } else capReads += 1;
      return Response.json({caps,values,value:350_000});
    }
    return fallback(input,init);
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  await act(async () => { root=createRoot(container); root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>); });
  const settle=async()=>{await new Promise(resolve=>testWindow.setTimeout(resolve,0));};
  await act(settle);
  const cluster=()=>container.querySelector<HTMLElement>(".models-cap-cluster")!;
  const toggle=()=>cluster().querySelector<HTMLButtonElement>("button.switch")!;
  expect(cluster().textContent).toContain("128k");
  await act(async()=>{toggle().click();await settle();});
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(cluster().textContent).toContain("128k");
  const readsBeforeReload = capReads;
  await act(async () => { root!.unmount(); root = null; });
  clearClientResourceStoresForTests();
  testWindow.sessionStorage.clear();
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>);
  });
  await act(settle);
  expect(capReads).toBeGreaterThan(readsBeforeReload);
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(cluster().textContent).toContain("128k");
  expect(bodies).toEqual([{ provider: "openai", enabled: false }]);
  await act(async()=>{toggle().click();await settle();});
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  expect(cluster().textContent).toContain("128k");
  expect(bodies).toEqual([{provider:"openai",enabled:false},{provider:"openai",enabled:true}]);
});

test.each([
  { response: { caps: { anthropic: 128_000 }, value: 350_000 }, label: "128k", enabled: true },
  { response: { caps: {}, value: 600_000 }, label: "600k", enabled: false },
  { response: { caps: {}, cap: 350_000 }, label: "350k", enabled: false },
])("legacy cap response $response falls back without remembered values", async ({ response, label, enabled }) => {
  // The existing seed is also the old cache shape, without contextCapValues.
  const fallback = globalThis.fetch;
  let capReads = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/provider-context-caps")) {
      capReads += 1;
      return Response.json(response);
    }
    return fallback(input, init);
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>);
  });
  await act(async () => {
    await new Promise(resolve => testWindow.setTimeout(resolve, 0));
  });
  expect(capReads).toBeGreaterThan(0);
  const cluster = container.querySelector<HTMLElement>(".models-cap-cluster")!;
  expect(cluster.textContent).toContain(label);
  expect(cluster.querySelector("button.switch")?.getAttribute("aria-pressed")).toBe(String(enabled));
});

const catalogRefreshFailures = [
  { client: "pi", ok: false, reason: "Pi file changed outside opencodex" },
  { client: "aside", profileId: 2, ok: false, reason: "Profile file busy" },
];
const integrationWarningCopy = "Model selection saved. Some client catalogs could not be refreshed. Check Integrations before starting a new session.";

async function waitForModelsFeedback(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Models feedback did not settle: ${container.textContent}`);
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
  }
}

function allOffButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "All off");
  if (!button) throw new Error("All off button not found");
  return button;
}

async function mountModelsForRefreshWarning(): Promise<void> {
  clearClientResourceStoresForTests();
  testWindow.localStorage.setItem("ocx-lang", "en");
  installFakeTimers();
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>);
  });
  await waitForModelsFeedback(() => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .some(button => button.textContent === "All off" && !button.disabled));
}

test("a saved selection keeps its success toast and separate catalog warning until the next successful refresh", async () => {
  const fallback = globalThis.fetch;
  let mutations = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/model-visibility") && init?.method === "PUT") {
      mutations += 1;
      return Response.json({ ok: true, clientIntegrations: mutations === 1 ? catalogRefreshFailures : [
        { client: "pi", ok: true, changed: true },
        { client: "aside", profileId: 2, ok: true, changed: true },
      ] });
    }
    return fallback(input, init);
  }) as typeof fetch;
  await mountModelsForRefreshWarning();
  await act(async () => { allOffButton().click(); });
  await waitForModelsFeedback(() => Boolean(container.querySelector(".action-toast.notice-ok")) && !allOffButton().disabled);
  const toast = container.querySelector<HTMLElement>(".action-toast")!;
  const warning = container.querySelector<HTMLElement>(".models-integration-warning")!;
  expect(mutations).toBe(1);
  expect(toast.textContent).toContain("Applied");
  expect(toast.getAttribute("role")).toBe("status");
  expect(warning).not.toBeNull();
  expect(warning.querySelector(".notice.notice-warn")).not.toBeNull();
  expect(warning.hasAttribute("hidden")).toBe(false);
  expect(warning.closest(".action-toast")).toBeNull();
  expect(warning.textContent).toContain(integrationWarningCopy);
  expect(warning.textContent).toContain("Pi file changed outside opencodex");
  expect(warning.textContent).toContain("Profile file busy");
  expect(warning.textContent).toMatch(/aside[\s\S]*2/i);
  await fireTimers(6000);
  expect(container.querySelector(".action-toast")).toBeNull();
  expect(container.querySelector(".models-integration-warning")?.textContent).toContain(integrationWarningCopy);
  await act(async () => { allOffButton().click(); });
  await waitForModelsFeedback(() => mutations === 2 && Boolean(container.querySelector(".action-toast.notice-ok")) && !allOffButton().disabled);
  expect(container.querySelector(".models-integration-warning")).toBeNull();
  expect(container.textContent).not.toContain("Pi file changed outside opencodex");
  expect(container.textContent).not.toContain("Profile file busy");
});

test.each([false, true])("HTTP save failure does not publish a new saved-selection warning (prior warning=%s)", async priorWarning => {
  const fallback = globalThis.fetch;
  let rejectSave = !priorWarning;
  let mutations = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/model-visibility") && init?.method === "PUT") {
      mutations += 1;
      return rejectSave
        ? Response.json({ error: "Selection could not be saved", clientIntegrations: [
          { client: "pi", ok: false, reason: "This rejected save must not create a catalog warning" },
        ] }, { status: 500 })
        : Response.json({ ok: true, clientIntegrations: catalogRefreshFailures });
    }
    return fallback(input, init);
  }) as typeof fetch;
  await mountModelsForRefreshWarning();
  if (priorWarning) {
    await act(async () => { allOffButton().click(); });
    await waitForModelsFeedback(() => Boolean(container.querySelector(".action-toast.notice-ok")) && !allOffButton().disabled);
    expect(container.querySelector(".models-integration-warning")?.textContent).toContain(integrationWarningCopy);
    rejectSave = true;
  }
  await act(async () => { allOffButton().click(); });
  await waitForModelsFeedback(() => Boolean(container.querySelector(".action-toast.notice-err")) && !allOffButton().disabled);
  expect(mutations).toBe(priorWarning ? 2 : 1);
  expect(container.querySelector(".action-toast")?.textContent).toContain("Save failed");
  expect(container.querySelector(".action-toast.notice-ok")).toBeNull();
  expect(container.textContent).not.toContain("This rejected save must not create a catalog warning");
  // An earlier warning may remain useful; a failed save cannot introduce a new one.
  if (!priorWarning) {
    expect(container.querySelector(".models-integration-warning")).toBeNull();
    expect(container.textContent).not.toContain(integrationWarningCopy);
  }
});

const providerPresetPreview = { providers: { anthropic: {
  mode: "all", availableVersion: 1, presetIds: ["claude-sonnet-5"], presetCount: 1, totalCount: 2,
} } };

function presetButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
    .find(node => node.textContent === "Preset");
  if (!button) throw new Error("Anthropic preset selector not found");
  return button;
}

for (const reportsRefresh of [false, true]) {
  test(`preset-empty keeps the previous integration warning (${reportsRefresh ? "success metadata present" : "no refresh metadata"})`, async () => {
    const fallback = globalThis.fetch;
    const presetWrites: unknown[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith("/api/model-presets")) {
        if (init?.method !== "PUT") return Response.json(providerPresetPreview);
        presetWrites.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true, provider: "anthropic", fallback: "preset-empty", selected: [],
          ...(reportsRefresh ? { clientIntegrations: [{ client: "pi", ok: true }, { client: "aside", profileId: 2, ok: true }] } : {}),
        });
      }
      if (String(input).endsWith("/api/model-visibility") && init?.method === "PUT") {
        return Response.json({ ok: true, clientIntegrations: catalogRefreshFailures });
      }
      return fallback(input, init);
    }) as typeof fetch;
    await mountModelsForRefreshWarning();
    await waitForModelsFeedback(() => Boolean(container.querySelector('button[role="radio"]')));
    await act(async () => { allOffButton().click(); });
    await waitForModelsFeedback(() => Boolean(container.querySelector(".action-toast.notice-ok")) && !allOffButton().disabled);
    const warningBefore = container.querySelector(".models-integration-warning")?.textContent;
    expect(warningBefore).toContain("Pi file changed outside opencodex");
    expect(warningBefore).toContain("Profile file busy");
    await act(async () => { presetButton().click(); });
    await waitForModelsFeedback(() => container.querySelector(".action-toast")?.textContent?.includes("preset matched no models") === true
      && !presetButton().disabled);
    expect(presetWrites).toEqual([{ provider: "anthropic", mode: "preset" }]);
    expect(container.querySelector(".action-toast.notice-ok")).toBeNull();
    expect(container.querySelector(".action-toast")?.textContent).toContain("selection unchanged");
    expect(container.querySelector(".models-integration-warning")?.textContent).toBe(warningBefore);
  });
}

test.each(["preset", "visibility"] as const)("an in-flight %s mutation blocks the competing catalog mutation", async first => {
  const fallback = globalThis.fetch;
  const writes: string[] = [];
  let gateMutations = false;
  let release!: (response: Response) => void;
  const responseGate = new Promise<Response>(resolve => { release = resolve; });
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/model-presets" && init?.method !== "PUT") return Response.json(providerPresetPreview);
    if ((path === "/api/model-presets" || path === "/api/model-visibility") && init?.method === "PUT") {
      writes.push(path);
      return gateMutations ? responseGate : Response.json({ ok: true, clientIntegrations: catalogRefreshFailures });
    }
    return fallback(input, init);
  }) as typeof fetch;
  await mountModelsForRefreshWarning();
  await waitForModelsFeedback(() => Boolean(container.querySelector('button[role="radio"]')));
  await act(async () => { allOffButton().click(); });
  await waitForModelsFeedback(() => Boolean(container.querySelector(".action-toast.notice-ok")) && !allOffButton().disabled);
  const warningBefore = container.querySelector(".models-integration-warning")?.textContent;
  expect(warningBefore).toContain(integrationWarningCopy);
  gateMutations = true;
  const expectedWrites = ["/api/model-visibility", first === "preset" ? "/api/model-presets" : "/api/model-visibility"];
  try {
    // Both clicks occur before React can paint disabled controls: the shared flight guard owns this race.
    await act(async () => {
      if (first === "preset") { presetButton().click(); allOffButton().click(); }
      else { allOffButton().click(); presetButton().click(); }
    });
    expect(writes).toEqual(expectedWrites);
    expect(allOffButton().disabled).toBe(true);
    expect(presetButton().disabled).toBe(true);
    expect(container.querySelector(".models-integration-warning")?.textContent).toBe(warningBefore);
    await act(async () => { allOffButton().click(); presetButton().click(); });
    expect(writes).toEqual(expectedWrites);
  } finally {
    await act(async () => { release(Response.json({ ok: true, selected: ["claude-sonnet-5"], clientIntegrations: [
      { client: "pi", ok: true, changed: true }, { client: "aside", profileId: 2, ok: true, changed: true },
    ] })); });
  }
  await waitForModelsFeedback(() => !allOffButton().disabled && !presetButton().disabled);
  expect(writes).toEqual(expectedWrites);
  expect(container.querySelector(".models-integration-warning")).toBeNull();
  expect(container.querySelector(".action-toast.notice-ok")).not.toBeNull();
});


function pickerApply(): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Apply order")!;
}
async function choosePickerOrder(label: string): Promise<void> {
  const selector = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="Picker order"]')!;
  await act(async () => { selector.click(); });
  const option = [...testWindow.document.querySelectorAll('[role="option"]')].find(node => node.textContent === label)!;
  await act(async () => { (option as unknown as HTMLButtonElement).click(); });
}

test("picker applies only picker fields, keeps Most used on reload, and surfaces refresh pending", async () => {
  const baseFetch = globalThis.fetch;
  const available = ["anthropic/claude-sonnet-5", "anthropic/claude-opus-4-5"];
  let saved: { pickerOrder: string[]; pickerOrderMode: string | null } = { pickerOrder: [], pickerOrderMode: null };
  let usageCalls = 0;
  const writes: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/subagent-models")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)); writes.push(body); saved = body;
        return Response.json({ ok: true, ...saved, catalogRefresh: { status: "skipped", reason: "busy", retryable: true } });
      }
      return Response.json({ pickerAvailable: available, ...saved });
    }
    if (url.includes("/api/usage?")) { usageCalls++; return Response.json({ models: [
      { provider: "anthropic", model: "claude-sonnet-5", requests: 8 },
    ] }); }
    return baseFetch(input, init);
  }) as typeof fetch;
  await mountModelsForRefreshWarning();
  await waitForModelsFeedback(() => !!pickerApply() && !pickerApply().disabled);
  expect(usageCalls).toBe(0);
  await choosePickerOrder("Most used snapshot");
  await act(async () => { pickerApply().click(); });
  await waitForModelsFeedback(() => writes.length === 1 && !!container.querySelector(".action-toast"));
  expect(writes).toEqual([{ pickerOrder: available, pickerOrderMode: "most-used" }]);
  expect(container.querySelector(".action-toast")?.textContent).toContain("catalog refresh is pending");
  expect(usageCalls).toBe(1);
  await act(async () => { root!.unmount(); });
  root = null;
  await mountModelsForRefreshWarning();
  await waitForModelsFeedback(() => container.querySelector('[aria-label="Picker order"]')?.textContent?.includes("Most used snapshot") === true);
  expect(usageCalls).toBe(1);
});

test("picker Default clears saved order with truly empty model and provider inventories", async () => {
  const baseFetch = globalThis.fetch;
  let written: unknown;
  testWindow.sessionStorage.removeItem("ocx.models.catalog.v1:http://localhost");
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/models") || String(input).endsWith("/api/providers")) return Response.json([]);
    if (String(input).endsWith("/api/subagent-models")) {
      if (init?.method === "PUT") {
        written = JSON.parse(String(init.body));
        return Response.json({ ok: true, pickerOrder: [], pickerOrderMode: null,
          catalogRefresh: { status: "committed", degraded: false, changed: true, notices: [] } });
      }
      return Response.json({ pickerAvailable: [], pickerOrder: ["gone/model"], pickerOrderMode: "most-used" });
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  clearClientResourceStoresForTests();
  testWindow.localStorage.setItem("ocx-lang", "en");
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>);
  });
  await waitForModelsFeedback(() => container.querySelector<HTMLButtonElement>('[aria-label="Picker order"]')?.disabled === false);
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "All off")).toBe(false);
  await choosePickerOrder("Default");
  expect(pickerApply().disabled).toBe(false);
  await act(async () => { pickerApply().click(); });
  await waitForModelsFeedback(() => written !== undefined);
  expect(written).toEqual({ pickerOrder: null, pickerOrderMode: null });
});

test("malformed picker save remains retryable and never publishes success", async () => {
  const baseFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => String(input).endsWith("/api/subagent-models") && init?.method === "PUT"
    ? Response.json({ ok: true }) : baseFetch(input, init)) as typeof fetch;
  await mountModelsForRefreshWarning();
  await waitForModelsFeedback(() => !!pickerApply() && !pickerApply().disabled);
  await choosePickerOrder("Group by provider");
  await act(async () => { pickerApply().click(); });
  await waitForModelsFeedback(() => !!container.querySelector(".action-toast") && !pickerApply().disabled);
  expect(container.querySelector(".action-toast.notice-ok")).toBeNull();
  expect(container.querySelector('[aria-label="Picker order"]')?.textContent).toContain("Group by provider");
});


test("a late picker GET cannot overwrite a saved order or its session cache", async () => {
  const baseFetch = globalThis.fetch;
  const available = ["anthropic/claude-sonnet-5", "anthropic/claude-opus-4-5"];
  const old = { pickerAvailable: available, pickerOrder: [], pickerOrderMode: null };
  testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost:picker-order", JSON.stringify(old));
  let releaseGet!: (response: Response) => void;
  let writes = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/subagent-models")) {
      if (init?.method === "PUT") {
        writes++;
        return Response.json({ ok: true, ...JSON.parse(String(init.body)),
          catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] } });
      }
      return new Promise<Response>(resolve => { releaseGet = resolve; });
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  await mountModelsForRefreshWarning();
  await waitForModelsFeedback(() => !!releaseGet && !!pickerApply() && !pickerApply().disabled);
  await choosePickerOrder("Group by provider");
  const button = pickerApply();
  await act(async () => { button.click(); button.click(); });
  await waitForModelsFeedback(() => writes === 1 && !!container.querySelector(".action-toast.notice-ok"));
  await act(async () => { releaseGet(Response.json(old)); });
  expect(container.querySelector('[aria-label="Picker order"]')?.textContent).toContain("Group by provider");
  const cached = JSON.parse(testWindow.sessionStorage.getItem("ocx.models.catalog.v1:http://localhost:picker-order")!);
  expect(cached.pickerOrderMode).toBe("provider");
  expect(cached.pickerOrder).toEqual(["anthropic/claude-opus-4-5", "anthropic/claude-sonnet-5"]);
});

test("leaving Models aborts its pending picker save", async () => {
  const baseFetch = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  let finish!: (response: Response) => void;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/api/subagent-models") && init?.method === "PUT") {
      signal = init.signal;
      return new Promise<Response>(resolve => { finish = resolve; });
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  await mountModelsForRefreshWarning();
  await waitForModelsFeedback(() => !!pickerApply() && !pickerApply().disabled);
  await act(async () => { pickerApply().click(); });
  await waitForModelsFeedback(() => !!finish);
  await act(async () => { root!.unmount(); });
  root = null;
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish(Response.json({ ok: true, pickerOrder: [], pickerOrderMode: null })); });
  expect(container.querySelector(".action-toast")).toBeNull();
});


function holdPostSaveAppServerRead() {
  const baseFetch = globalThis.fetch;
  let aReads = 0;
  let heldSignal: AbortSignal | null | undefined;
  let release: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/system/codex-app-server")) {
      if (url.startsWith("http://proxy-b/")) return Response.json({ state: "stale", runningCount: 1 });
      aReads++;
      if (aReads === 2) {
        heldSignal = init?.signal;
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return Response.json({ state: "fresh", runningCount: 1 });
    }
    if (url.endsWith("/api/subagent-models") && init?.method === "PUT") {
      return Response.json({ ok: true, ...JSON.parse(String(init.body)),
        catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] } });
    }
    return baseFetch(input, init);
  }) as typeof fetch;
  return {
    ready: () => release !== undefined,
    signal: () => heldSignal,
    reads: () => aReads,
    release: (state: "fresh" | "stale") => release!(Response.json({ state, runningCount: 1 })),
  };
}

async function savePickerWithHeldStatus(): Promise<ReturnType<typeof holdPostSaveAppServerRead>> {
  const pending = holdPostSaveAppServerRead();
  await mountModelsForRefreshWarning();
  await waitForModelsFeedback(() => !!pickerApply() && !pickerApply().disabled && pending.reads() === 1);
  await choosePickerOrder("Group by provider");
  await act(async () => { pickerApply().click(); });
  await waitForModelsFeedback(() => pending.ready() && !!container.querySelector(".action-toast.notice-ok")
    && !!pickerApply() && !pickerApply().disabled);
  // PUT has completed and released its own owner; the observational owner must remain.
  expect(pending.signal()?.aborted).toBe(false);
  return pending;
}

test("post-save A status cannot replace B's banner after apiBase changes", async () => {
  const pending = await savePickerWithHeldStatus();
  await act(async () => {
    root!.render(<LanguageProvider><Models apiBase="http://proxy-b" /></LanguageProvider>);
  });
  await waitForModelsFeedback(() => !!container.querySelector(".codex-stale-banner"));
  expect(pending.signal()?.aborted).toBe(true);
  // The late callback must remain ineligible even when transport ignores cancellation.
  await act(async () => { pending.release("fresh"); });
  expect(container.querySelector(".codex-stale-banner")).not.toBeNull();
  const savedA = JSON.parse(testWindow.sessionStorage.getItem("ocx.models.catalog.v1:http://localhost:picker-order")!);
  expect(savedA.pickerOrderMode).toBe("provider");
});

test("same-base newer app-server reading wins over the held post-save reading", async () => {
  const pending = await savePickerWithHeldStatus();
  await act(async () => {
    root!.render(<LanguageProvider><Models apiBase="http://localhost" restartEpoch={1} /></LanguageProvider>);
  });
  await waitForModelsFeedback(() => pending.reads() === 3);
  expect(pending.signal()?.aborted).toBe(true);
  await act(async () => { pending.release("stale"); });
  expect(container.querySelector(".codex-stale-banner")).toBeNull();
  expect(container.querySelector(".action-toast.notice-ok")).not.toBeNull();
});

test("manual deadline remains owned after PUT success and timeout cannot undo the save", async () => {
  const pending = holdPostSaveAppServerRead();
  await mountModelsForRefreshWarning();
  await waitForModelsFeedback(() => !!pickerApply() && !pickerApply().disabled && pending.reads() === 1);
  const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0;
  try {
    Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
    globalThis.setTimeout = ((callback: () => void, ms: number) => {
      const id = ++timerId;
      timers.set(id, { callback, ms });
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
    await choosePickerOrder("Group by provider");
    await act(async () => { pickerApply().click(); });
    await waitForModelsFeedback(() => pending.ready() && !!container.querySelector(".action-toast.notice-ok")
      && !!pickerApply() && !pickerApply().disabled);
    const deadlines = [...timers.values()].filter(timer => timer.ms === 15_000);
    expect(deadlines).toHaveLength(1);
    await act(async () => { deadlines[0]!.callback(); });
    expect(pending.signal()?.aborted).toBe(true);
    await act(async () => { pending.release("stale"); });
    expect(container.querySelector(".codex-stale-banner")).toBeNull();
    expect(container.querySelector(".action-toast.notice-ok")).not.toBeNull();
    expect(container.querySelector('[aria-label="Picker order"]')?.textContent).toContain("Group by provider");
  } finally {
    if (originalAny) Object.defineProperty(AbortSignal, "any", originalAny);
    else Reflect.deleteProperty(AbortSignal, "any");
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
