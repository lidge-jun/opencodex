import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";

/**
 * The sub-agent limit selector edits the logical child count in every multi-agent
 * mode (v1, base, v2, hybrid). /api/v2 reports the limit in the ACTIVE backends
 * units — [agents] counts children, V2 storage counts the root slot too — so the
 * rendered number subtracts one only while the global flag is on, and PUTs add it
 * back. Previously the control rendered only while v2.enabled was true.
 */

const globals = [
  "document", "window", "navigator", "localStorage", "sessionStorage",
  "IS_REACT_ACT_ENVIRONMENT", "setInterval", "clearInterval", "fetch",
] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let v2Body: Record<string, unknown>;
let v2Puts: Array<Record<string, unknown>>;
let pollTicks: Array<() => void>;
let deferV2Gets: boolean;
let pendingV2Gets: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }>;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  root = null;
  v2Puts = [];
  pollTicks = [];
  deferV2Gets = false;
  pendingV2Gets = [];
  v2Body = { enabled: false, multiAgentMode: "v1", maxConcurrentThreadsPerSession: 16 };
  testWindow = new Window({ url: "http://localhost/" });
  // The v2 status poll runs on window.setInterval (visibility-poll.ts); capturing the
  // tick lets a test hold a GET in flight across a write instead of waiting 10s.
  testWindow.setInterval = ((fn: () => void) => { pollTicks.push(fn); return pollTicks.length; }) as typeof setInterval;
  testWindow.clearInterval = (() => {}) as typeof clearInterval;
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
    ],
    providers: [{ name: "anthropic", liveModels: true, models: ["claude-sonnet-5"] }],
    selectedModels: {},
    disabled: [],
    contextCaps: {},
    contextCapValue: 350_000,
  }));
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v2")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        v2Puts.push(body);
        v2Body = { ...v2Body, ...body };
        // Selecting v1 unconditionally drops the native flag (agent-settings-routes modeFlag).
        if (body.multiAgentMode === "v1") v2Body = { ...v2Body, enabled: false };
        return Response.json(v2Body);
      }
      if (deferV2Gets) {
        return new Promise<Response>((resolve, reject) => pendingV2Gets.push({ resolve, reject }));
      }
      return Response.json(v2Body);
    }
    if (url.endsWith("/api/subagent-models") && init?.method !== "PUT") {
      return Response.json({ pickerAvailable: ["anthropic/claude-sonnet-5"], pickerOrder: [], pickerOrderMode: null });
    }
    if (url.endsWith("/api/models")) {
      return Response.json([
        { provider: "anthropic", id: "claude-sonnet-5", namespaced: "anthropic/claude-sonnet-5", disabled: false },
      ]);
    }
    if (url.endsWith("/api/providers")) return Response.json([{ name: "anthropic", liveModels: true, models: ["claude-sonnet-5"] }]);
    if (url.endsWith("/api/selected-models")) return Response.json({ selected: {} });
    if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
    if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
    if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
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

async function mount() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Models apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
}

const limitSelect = () =>
  container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Sub-agent limit"]');
const options = () =>
  [...testWindow.document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')];
async function pickOption(label: string) {
  await act(async () => { limitSelect()!.click(); });
  const option = options().find(node => node.textContent === label);
  expect(option, "option " + label).toBeDefined();
  await act(async () => { option!.click(); });
}
const lastPut = () => v2Puts.at(-1);

async function applyCustomLimit(value: string) {
  await pickOption("Custom…");
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Sub-agent limit"]')!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
  });
  const apply = [...container.querySelectorAll<HTMLButtonElement>(".models-v2-detail-row button")]
    .find(node => node.textContent === "Apply")!;
  await act(async () => { apply.click(); });
}

const subagentRadios = () => [
  ...container.querySelectorAll<HTMLButtonElement>(
    '[role="radiogroup"][aria-label="Sub-agent"] button[role="radio"]'),
];
const checkedMode = () => subagentRadios().find(node => node.getAttribute("aria-checked") === "true");
async function clickV1Mode() {
  const radio = subagentRadios().find(node => node.textContent === "v1");
  expect(radio).toBeDefined();
  await act(async () => { radio!.click(); });
}
async function firePollTick() {
  await act(async () => { pollTicks.forEach(fn => fn()); });
}

test("v1 mode exposes an editable child-count selector and PUTs the same units", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: false, multiAgentMode: "v1", maxConcurrentThreadsPerSession: 16 };
  await mount();

  const select = limitSelect();
  expect(select).not.toBeNull();
  expect(select!.disabled).toBe(false);
  expect(select!.textContent).toContain("16");

  await pickOption("32");
  expect(lastPut()).toEqual({ maxConcurrentThreadsPerSession: 32 });
});

test("hybrid v2 with the keep-native pin (enabled:false) stays editable in child units", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: false, multiAgentMode: "v2", keepNativeChatGptOnV1: true, maxConcurrentThreadsPerSession: 16 };
  await mount();

  const select = limitSelect();
  expect(select).not.toBeNull();
  expect(select!.textContent).toContain("16");

  await pickOption("64");
  expect(lastPut()).toEqual({ maxConcurrentThreadsPerSession: 64 });
});

test("full v2 presents children (stored total minus the root slot) and PUTs total back", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: true, multiAgentMode: "v2", maxConcurrentThreadsPerSession: 17 };
  await mount();

  const select = limitSelect();
  expect(select!.textContent).toContain("16");
  expect(select!.textContent).not.toContain("17");

  await pickOption("32");
  expect(lastPut()).toEqual({ maxConcurrentThreadsPerSession: 33 });
});

test("root-only V2 displays zero children and a custom one-child edit sends total two", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: true, multiAgentMode: "v2", maxConcurrentThreadsPerSession: 1 };
  await mount();
  expect(limitSelect()!.textContent).toBe("0");
  await applyCustomLimit("1");
  expect(v2Puts).toEqual([{ maxConcurrentThreadsPerSession: 2 }]);
  expect(limitSelect()!.textContent).toBe("1");
});

test("the folded root-only V2 summary displays zero children", async () => {
  v2Body = { enabled: true, multiAgentMode: "v2", maxConcurrentThreadsPerSession: 1 };
  await mount();
  const chip = container.querySelector('.models-settings-kv[data-item="threads"]');
  expect(chip?.querySelector(".models-settings-v")?.textContent).toBe("0");
});

test.each([
  [false, "v1", false],
  [false, "v2", true],
] as const)("%s global flag / %s surface / hybrid %s keeps a one-child edit in child units", async (enabled, multiAgentMode, keepNativeChatGptOnV1) => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled, multiAgentMode, keepNativeChatGptOnV1, maxConcurrentThreadsPerSession: 16 };
  await mount();
  await applyCustomLimit("1");
  expect(v2Puts).toEqual([{ maxConcurrentThreadsPerSession: 1 }]);
});

test.each([
  [false, Number.MAX_SAFE_INTEGER + 1],
  [true, Number.MAX_SAFE_INTEGER + 1],
  [true, Number.MAX_SAFE_INTEGER],
] as const)("global V2 %s rejects unsafe child/backend limit %s without a PUT", async (enabled, value) => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled, multiAgentMode: enabled ? "v2" : "v1", maxConcurrentThreadsPerSession: 16 };
  await mount();
  await applyCustomLimit(String(value));
  expect(v2Puts).toHaveLength(0);
  expect(container.textContent).toContain("Sub-agent limit must be an integer >= 1");
});

test.each([
  [false, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  [true, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER],
] as const)("global V2 %s accepts largest safe child limit %s as backend %s", async (enabled, children, total) => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled, multiAgentMode: enabled ? "v2" : "v1", maxConcurrentThreadsPerSession: 16 };
  await mount();
  await applyCustomLimit(String(children));
  expect(v2Puts).toEqual([{ maxConcurrentThreadsPerSession: total }]);
});

test("the V2 conflict warning identifies canonical agents limits as well as the legacy alias", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: true, multiAgentMode: "v2", agentsMaxThreadsConflict: true, maxConcurrentThreadsPerSession: 17 };
  await mount();

  const warning = container.querySelector(".models-v2-detail-row");
  expect(warning?.textContent).toContain("[agents] max_concurrent_threads_per_session / max_threads");
});

test("the folded settings summary names the returned child limit in any mode", async () => {
  // Panel stays folded (no settingsOpen key): the summary line must still carry the value.
  v2Body = { enabled: false, multiAgentMode: "v1", maxConcurrentThreadsPerSession: 16 };
  await mount();

  const chip = container.querySelector('.models-settings-kv[data-item="threads"]');
  expect(chip).not.toBeNull();
  expect(chip!.textContent).toContain("Sub-agent limit");
  expect(chip!.textContent).toContain("16");
});

test("an unset limit shows the runtime-default placeholder without a hardcoded number", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: false, multiAgentMode: "v1" };
  await mount();

  const select = limitSelect();
  expect(select).not.toBeNull();
  expect(select!.textContent).toContain("default");
  expect(select!.textContent).not.toContain("(4)");
});

test("the custom entry path still PUTs through the shared writer", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: false, multiAgentMode: "v1", maxConcurrentThreadsPerSession: 16 };
  await mount();

  await pickOption("Custom…");
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Sub-agent limit"]')!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, "24");
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as unknown as Event);
  });
  const apply = [...container.querySelectorAll<HTMLButtonElement>(".models-v2-detail-row button")]
    .find(node => node.textContent === "Apply")!;
  await act(async () => { apply.click(); });
  expect(lastPut()).toEqual({ maxConcurrentThreadsPerSession: 24 });
});

/**
 * FreshLuna P2: a poll GET issued before a write can resolve AFTER the write's
 * response was adopted. Without a freshness check the stale body reverts
 * v2.enabled, and the next limit save converts in the wrong backend's units.
 */
test("a poll response older than a completed mode write is discarded", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: true, multiAgentMode: "v2", maxConcurrentThreadsPerSession: 17 };
  await mount();
  expect(limitSelect()!.textContent).toContain("16");

  // The 10s poll issues a GET that stays in flight across the mode write below.
  deferV2Gets = true;
  await firePollTick();
  expect(pendingV2Gets).toHaveLength(1);

  // The write lands first and its response is the fresher state: v1 backend.
  await clickV1Mode();
  expect(checkedMode()!.textContent).toBe("v1");

  // The stale snapshot (flag still on) arrives late and must not be applied.
  const stale = { enabled: true, multiAgentMode: "v2", maxConcurrentThreadsPerSession: 17 };
  await act(async () => {
    pendingV2Gets.shift()!.resolve(Response.json(stale));
  });
  expect(checkedMode()!.textContent).toBe("v1");

  // Child units still — a reverted flag would silently send 33 here.
  await pickOption("32");
  expect(lastPut()).toEqual({ maxConcurrentThreadsPerSession: 32 });
});

test("a stale poll resolving non-JSON after a write keeps the fresh state", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: true, multiAgentMode: "v2", maxConcurrentThreadsPerSession: 17 };
  await mount();

  deferV2Gets = true;
  await firePollTick();
  expect(pendingV2Gets).toHaveLength(1);

  await clickV1Mode();
  await act(async () => {
    pendingV2Gets.shift()!.resolve(new Response(null, { status: 404 }));
  });

  // Discarded, not applied as null: the row stays editable on the fresh v1 state.
  const select = limitSelect();
  expect(select).not.toBeNull();
  expect(select!.textContent).toContain("17");
});

test("a stale poll rejection after a write keeps the fresh state", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: true, multiAgentMode: "v2", maxConcurrentThreadsPerSession: 17 };
  await mount();

  deferV2Gets = true;
  await firePollTick();
  expect(pendingV2Gets).toHaveLength(1);

  await clickV1Mode();
  await act(async () => {
    pendingV2Gets.shift()!.reject(new Error("late network failure"));
    await Promise.resolve();
  });

  expect(limitSelect()).not.toBeNull();
  expect(limitSelect()!.textContent).toContain("17");
});

test("an older poll response never overrides a newer one", async () => {
  testWindow.localStorage.setItem("ocx.models.settingsOpen.v1", "1");
  v2Body = { enabled: false, multiAgentMode: "v1", maxConcurrentThreadsPerSession: 16 };
  await mount();

  deferV2Gets = true;
  await firePollTick();
  await firePollTick();
  expect(pendingV2Gets).toHaveLength(2);

  // Newer response first, then the superseded older one: last write wins is wrong here.
  await act(async () => {
    pendingV2Gets[1].resolve(Response.json({ enabled: false, multiAgentMode: "v1", maxConcurrentThreadsPerSession: 64 }));
  });
  expect(limitSelect()!.textContent).toContain("64");
  await act(async () => {
    pendingV2Gets[0].resolve(Response.json({ enabled: false, multiAgentMode: "v1", maxConcurrentThreadsPerSession: 8 }));
  });
  expect(limitSelect()!.textContent).toContain("64");
});
