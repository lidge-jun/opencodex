import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { ULTRA_MODE_PRESET } from "../src/components/subagents-workspace/SubagentDelegationSection";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let v2Responses: Array<{ ok: boolean; body: unknown; status?: number }> = [];
let v2Call = 0;
let requests: Array<{ url: string; init?: RequestInit }> = [];
let injectionAvailable: Array<{ provider: string; model: string; namespaced: string; canonical?: boolean }> = [];
let nativeOverrideServer = { enabled: false, model: null as string | null, active: false };
let nativeOverridePutError: string | null = null;
let nativeOverrideAfterPut: Partial<typeof nativeOverrideServer> | null = null;

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = [];
  v2Responses = [];
  v2Call = 0;
  injectionAvailable = [];
  nativeOverrideServer = { enabled: false, model: null, active: false };
  nativeOverridePutError = null;
  nativeOverrideAfterPut = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const path = new URL(String(url), "http://localhost/").pathname;
      if (path === "/api/v2") {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body ?? "{}")) as { v2NativeParentOverride?: { enabled?: boolean; model?: string | null } };
          if (body.v2NativeParentOverride) {
            if (nativeOverridePutError) return response({ error: nativeOverridePutError }, false, 400);
            nativeOverrideServer = { ...nativeOverrideServer, ...body.v2NativeParentOverride, ...nativeOverrideAfterPut };
            nativeOverrideAfterPut = null;
            return response({ ok: true, v2NativeParentOverride: nativeOverrideServer });
          }
          const latest = v2Responses.at(-1)?.body ?? { enabled: true, multiAgentMode: "v2", multiAgentModeHintText: null };
          return response(latest);
        }
        const next = v2Responses[Math.min(v2Call++, Math.max(v2Responses.length - 1, 0))];
        if (!next) return response({ enabled: false, v2NativeParentOverride: nativeOverrideServer });
        const body = next.body && typeof next.body === "object" && !Array.isArray(next.body) && !Object.hasOwn(next.body, "v2NativeParentOverride")
          ? { ...next.body, v2NativeParentOverride: nativeOverrideServer }
          : next.body;
        return response(body, next.ok, next.status ?? (next.ok ? 200 : 500));
      }
      if (path === "/api/subagent-models") return response({ available: [], chosen: [] });
      if (path === "/api/injection-model") return response({ available: injectionAvailable, efforts: [] });
      return response({});
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mount(apiBase = "") {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Subagents apiBase={apiBase} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
}

function ultraSwitch(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find(candidate => candidate.getAttribute("aria-label") === "Ultra mode");
  if (!button) throw new Error("Ultra mode switch not found");
  return button as HTMLButtonElement;
}

function nativeParentSwitch(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find(candidate => candidate.getAttribute("aria-label") === "Route native V2 parents");
  if (!button) throw new Error("Native parent switch not found");
  return button as HTMLButtonElement;
}

function nativeParentSelect(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Native parent target model"]');
  if (!button) throw new Error("Native parent model select not found");
  return button;
}

function nativeParentPuts(): Array<{ enabled: boolean; model: string | null }> {
  return requests
    .filter(row => row.url.endsWith("/api/v2") && row.init?.method === "PUT")
    .map(row => JSON.parse(String(row.init?.body ?? "{}")).v2NativeParentOverride)
    .filter(Boolean);
}

test("does not enable Ultra mode for the default surface even when V2 is enabled", async () => {
  v2Responses = [{ ok: true, body: { enabled: true, multiAgentMode: "default", multiAgentModeHintText: null } }];
  await mount();

  expect(ultraSwitch().disabled).toBe(true);
  expect(ultraSwitch().getAttribute("aria-pressed")).toBe("false");
});

test("clears the page load error after a successful Ultra mode retry", async () => {
  v2Responses = [
    { ok: false, body: { error: "temporary failure" }, status: 503 },
    { ok: true, body: { enabled: true, multiAgentMode: "v2", multiAgentModeHintText: null } },
  ];
  await mount();

  expect(container.textContent).toContain("Failed to load Ultra mode settings");
  const retry = Array.from(container.querySelectorAll("button"))
    .find(button => button.textContent?.trim() === "Retry");
  expect(retry).toBeTruthy();

  await act(async () => { (retry as HTMLButtonElement).click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  expect(container.textContent).not.toContain("Failed to load Ultra mode settings");
  expect(ultraSwitch().disabled).toBe(false);
});

test("uses the complete canonical proactive delegation preset", () => {
  expect(ULTRA_MODE_PRESET).toBe([
    "Proactive multi-agent delegation is active.",
    "Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies.",
    "Delegate independent sub-tasks to sub-agents whenever parallel work would materially improve speed or quality — do not serialize work that can run concurrently.",
    "Each sub-agent runs in its own context and can use all available tools; prefer spawning specialists over doing everything yourself.",
    "This mode remains active until a later multi-agent mode developer message changes it.",
  ].join(" "));
});

test("a save refresh from an old API server cannot overwrite a newer server", async () => {
  let oldGets = 0;
  let releaseOldRefresh!: (value: Response) => void;
  const oldRefresh = new Promise<Response>(resolve => { releaseOldRefresh = resolve; });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const path = new URL(String(url), "http://localhost/").pathname;
      if (path === "/old/api/v2") {
        if (init?.method === "PUT") return response({ ok: true });
        oldGets++;
        if (oldGets === 1) return response({ enabled: true, multiAgentMode: "v2", multiAgentModeHintText: null });
        return oldRefresh;
      }
      if (path === "/new/api/v2") return response({ enabled: false, multiAgentMode: "default", multiAgentModeHintText: null });
      if (path.endsWith("/api/subagent-models")) return response({ available: [], chosen: [] });
      if (path.endsWith("/api/injection-model")) return response({ available: [], efforts: [] });
      return response({});
    },
  });

  await mount("/old");
  expect(ultraSwitch().disabled).toBe(false);
  await act(async () => { ultraSwitch().click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });

  await act(async () => {
    root!.render(
      <LanguageProvider>
        <Subagents apiBase="/new" />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(ultraSwitch().disabled).toBe(true);

  await act(async () => {
    releaseOldRefresh(response({ enabled: true, multiAgentMode: "v2", multiAgentModeHintText: ULTRA_MODE_PRESET }));
    await oldRefresh;
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  expect(ultraSwitch().disabled).toBe(true);
  expect(ultraSwitch().getAttribute("aria-pressed")).toBe("false");
});

test("hydrates native parent override off and filters canonical ChatGPT rows", async () => {
  injectionAvailable = [
    { provider: "openai", model: "gpt-5.6-luna", namespaced: "gpt-5.6-luna", canonical: true },
    { provider: "alias", model: "parent-model", namespaced: "alias/parent-model", canonical: true },
    { provider: "relay", model: "parent-model", namespaced: "relay/parent-model" },
  ];
  v2Responses = [{ ok: true, body: {
    enabled: true,
    multiAgentMode: "v2",
    keepNativeChatGptOnV1: false,
    v2NativeParentOverride: { enabled: false, model: null, active: false },
  } }, { ok: true, body: { enabled: true, multiAgentMode: "v2", keepNativeChatGptOnV1: false } }];
  await mount();

  expect(nativeParentSwitch().getAttribute("aria-pressed")).toBe("false");
  expect(container.textContent).not.toContain("alias/parent-model");
  await act(async () => { nativeParentSelect().click(); });
  const options = [...testWindow.document.querySelectorAll('[role="option"]')];
  expect(options).toHaveLength(2);
  expect(options.map(option => option.textContent).join(" ")).toContain("parent-model");
  expect(options.map(option => option.textContent).join(" ")).not.toContain("gpt-5.6-luna");
});

test("persists a routed target while disabled with a complete atomic payload", async () => {
  injectionAvailable = [{ provider: "relay", model: "parent-model", namespaced: "relay/parent-model" }];
  v2Responses = [{ ok: true, body: {
    enabled: true,
    multiAgentMode: "v2",
    keepNativeChatGptOnV1: false,
    v2NativeParentOverride: { enabled: false, model: null, active: false },
  } }];
  await mount();

  await act(async () => { nativeParentSelect().click(); });
  const option = [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(candidate => candidate.textContent?.includes("parent-model"));
  expect(option).toBeTruthy();
  await act(async () => { option!.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  expect(nativeParentPuts()).toContainEqual({ enabled: false, model: "relay/parent-model" });
  expect(nativeParentSwitch().getAttribute("aria-pressed")).toBe("false");
});

test("enables native parent routing with the selected model atomically", async () => {
  injectionAvailable = [{ provider: "relay", model: "parent-model", namespaced: "relay/parent-model" }];
  v2Responses = [{ ok: true, body: {
    enabled: true,
    multiAgentMode: "v2",
    keepNativeChatGptOnV1: false,
    v2NativeParentOverride: { enabled: false, model: "relay/parent-model", active: false },
  } }, { ok: true, body: { enabled: true, multiAgentMode: "v2", keepNativeChatGptOnV1: false } }];
  await mount();

  expect(nativeParentSwitch().disabled).toBe(false);
  await act(async () => { nativeParentSwitch().click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  expect(nativeParentPuts()).toContainEqual({ enabled: true, model: "relay/parent-model" });
  expect(nativeParentSwitch().getAttribute("aria-pressed")).toBe("true");
});

test("rolls back the native parent controls after a failed update", async () => {
  injectionAvailable = [
    { provider: "relay", model: "first-model", namespaced: "relay/first-model" },
    { provider: "relay", model: "second-model", namespaced: "relay/second-model" },
  ];
  nativeOverridePutError = "native parent target rejected";
  v2Responses = [{ ok: true, body: {
    enabled: true,
    multiAgentMode: "v2",
    keepNativeChatGptOnV1: false,
    v2NativeParentOverride: { enabled: false, model: "relay/first-model", active: false },
  } }];
  await mount();

  await act(async () => { nativeParentSelect().click(); });
  const option = [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(candidate => candidate.textContent?.includes("second-model"));
  await act(async () => { option!.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  expect(nativeParentSelect().textContent).toContain("first-model");
  expect(container.textContent).toContain("native parent target rejected");
});

test("uses the post-save GET as the source of truth", async () => {
  injectionAvailable = [
    { provider: "relay", model: "first-model", namespaced: "relay/first-model" },
    { provider: "relay", model: "server-model", namespaced: "relay/server-model" },
  ];
  nativeOverrideAfterPut = { model: "relay/server-model", enabled: false, active: false };
  v2Responses = [{ ok: true, body: {
    enabled: true,
    multiAgentMode: "v2",
    keepNativeChatGptOnV1: false,
    v2NativeParentOverride: { enabled: false, model: "relay/first-model", active: false },
  } }, { ok: true, body: { enabled: true, multiAgentMode: "v2", keepNativeChatGptOnV1: false } }];
  await mount();

  await act(async () => { nativeParentSelect().click(); });
  const option = [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(candidate => candidate.textContent?.includes("first-model"));
  await act(async () => { option!.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  expect(nativeParentSelect().textContent).toContain("server-model");
  expect(nativeParentSelect().textContent).not.toContain("first-model");
});

test("gates activation on the explicit V2 and keep-native state while preserving accessibility", async () => {
  injectionAvailable = [{ provider: "relay", model: "parent-model", namespaced: "relay/parent-model" }];
  v2Responses = [{ ok: true, body: {
    enabled: true,
    multiAgentMode: "v2",
    keepNativeChatGptOnV1: true,
    v2NativeParentOverride: { enabled: false, model: "relay/parent-model", active: false },
  } }];
  await mount();

  expect(nativeParentSwitch().disabled).toBe(true);
  expect(nativeParentSwitch().getAttribute("aria-pressed")).toBe("false");
  expect(nativeParentSelect().getAttribute("aria-label")).toBe("Native parent target model");
  expect(container.textContent).toContain("Requires explicit V2");
  expect(container.textContent).toContain("repository context");
});

test("shows inactive guidance when the upstream V2 flag is off", async () => {
  injectionAvailable = [{ provider: "relay", model: "parent-model", namespaced: "relay/parent-model" }];
  v2Responses = [{ ok: true, body: {
    enabled: false,
    multiAgentMode: "v2",
    keepNativeChatGptOnV1: false,
    v2NativeParentOverride: { enabled: false, model: "relay/parent-model", active: false },
  } }];
  await mount();

  expect(nativeParentSwitch().disabled).toBe(true);
  expect(container.textContent).toContain("Requires explicit V2");
});

test("keeps deactivation available for a persisted enabled but inactive conflict", async () => {
  injectionAvailable = [{ provider: "relay", model: "parent-model", namespaced: "relay/parent-model" }];
  v2Responses = [{ ok: true, body: {
    enabled: true,
    multiAgentMode: "default",
    keepNativeChatGptOnV1: true,
    v2NativeParentOverride: { enabled: true, model: "relay/parent-model", active: false },
  } }];
  await mount();

  expect(nativeParentSwitch().disabled).toBe(false);
  expect(nativeParentSwitch().getAttribute("aria-pressed")).toBe("true");
  await act(async () => { nativeParentSwitch().click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(nativeParentPuts()).toContainEqual({ enabled: false, model: "relay/parent-model" });
});

test("clearing the selected model atomically disables native parent routing", async () => {
  injectionAvailable = [{ provider: "relay", model: "parent-model", namespaced: "relay/parent-model" }];
  v2Responses = [{ ok: true, body: {
    enabled: true,
    multiAgentMode: "v2",
    keepNativeChatGptOnV1: false,
    v2NativeParentOverride: { enabled: true, model: "relay/parent-model", active: true },
  } }];
  await mount();

  await act(async () => { nativeParentSelect().click(); });
  const none = [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(candidate => candidate.textContent?.trim() === "None");
  expect(none).toBeTruthy();
  await act(async () => { none!.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  expect(nativeParentPuts()).toContainEqual({ enabled: false, model: null });
});

test("ignores rapid native parent mutations while one save is pending", async () => {
  injectionAvailable = [
    { provider: "relay", model: "first-model", namespaced: "relay/first-model" },
    { provider: "relay", model: "second-model", namespaced: "relay/second-model" },
  ];
  v2Responses = [{ ok: true, body: {
    enabled: true,
    multiAgentMode: "v2",
    keepNativeChatGptOnV1: false,
    v2NativeParentOverride: { enabled: false, model: "relay/first-model", active: false },
  } }];
  await mount();

  await act(async () => { nativeParentSelect().click(); });
  const second = [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(candidate => candidate.textContent?.includes("second-model"));
  await act(async () => {
    second!.click();
    nativeParentSwitch().click();
  });

  expect(nativeParentPuts()).toEqual([{ enabled: false, model: "relay/second-model" }]);
});
