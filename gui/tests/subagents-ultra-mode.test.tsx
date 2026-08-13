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
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const path = new URL(String(url), "http://localhost/").pathname;
      if (path === "/api/v2") {
        if (init?.method === "PUT") {
          const latest = v2Responses.at(-1)?.body ?? { enabled: true, multiAgentMode: "v2", multiAgentModeHintText: null };
          return response(latest);
        }
        const next = v2Responses[Math.min(v2Call++, Math.max(v2Responses.length - 1, 0))];
        return next ? response(next.body, next.ok, next.status ?? (next.ok ? 200 : 500)) : response({ enabled: false });
      }
      if (path === "/api/subagent-models") return response({ available: [], chosen: [] });
      if (path === "/api/injection-model") return response({ available: [], efforts: [] });
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
