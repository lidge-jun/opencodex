import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { useJsonConfigEditor, type Config } from "../src/hooks/useJsonConfigEditor";

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;

const config: Config = {
  port: 10100,
  defaultProvider: "alpha",
  providers: {
    alpha: {
      adapter: "openai-chat",
      baseUrl: "https://alpha.example.test/v1",
      defaultModel: "alpha-old",
      modelContextWindows: { "alpha-old": 131_072 },
      modelReasoningEfforts: { "alpha-old": ["low", "high"] },
      noVisionModels: ["alpha-old"],
      allowPrivateNetwork: true,
      hasApiKey: true,
      hasHeaders: true,
      note: "derived registry note",
    },
    beta: {
      adapter: "anthropic",
      baseUrl: "https://beta.example.test/v1",
      hasApiKey: false,
    },
  },
} as Config;

type Editor = ReturnType<typeof useJsonConfigEditor>;
type RequestRecord = { url: string; method: string; body: unknown };

let testWindow: Window;
let host: HTMLElement;
let root: Root | null;
let editor: Editor | null;
let requests: RequestRecord[];
let responseFactory: () => Promise<Response>;
let configRefreshes: number;
let quotaRefreshes: number;
let savedCallbacks: number;
let notifications: Array<{ message: string; ok?: boolean }>;

function Harness() {
  editor = useJsonConfigEditor({
    apiBase: "/editor",
    config,
    notify: (message, ok) => { notifications.push({ message, ok }); },
    fetchConfig: async () => { configRefreshes += 1; },
    fetchProviderQuotas: async () => { quotaRefreshes += 1; },
    onSaved: () => { savedCallbacks += 1; },
    t: key => key,
  });
  return null;
}

async function mountHook(): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness />);
  });
}

beforeEach(() => {
  testWindow = new Window({ url: "http://localhost" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
  root = null;
  editor = null;
  requests = [];
  configRefreshes = 0;
  quotaRefreshes = 0;
  savedCallbacks = 0;
  notifications = [];
  responseFactory = async () => Response.json({ success: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return responseFactory();
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  await testWindow.happyDOM?.close?.();
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: originalDocument },
    window: { configurable: true, value: originalWindow },
    navigator: { configurable: true, value: originalNavigator },
  });
  globalThis.fetch = originalFetch;
});

test("Save sends one atomic provider PUT with baseline and next, then refreshes", async () => {
  await mountHook();
  await act(async () => { editor!.openJsonEditor(); });

  const baseline = {
    defaultProvider: "alpha",
    providers: {
      alpha: {
        adapter: "openai-chat",
        baseUrl: "https://alpha.example.test/v1",
        defaultModel: "alpha-old",
        modelContextWindows: { "alpha-old": 131_072 },
        modelReasoningEfforts: { "alpha-old": ["low", "high"] },
        noVisionModels: ["alpha-old"],
        allowPrivateNetwork: true,
        note: "derived registry note",
      },
      beta: {
        adapter: "anthropic",
        baseUrl: "https://beta.example.test/v1",
      },
    },
  };
  expect(JSON.parse(editor!.draft)).toEqual(baseline);

  const next = structuredClone(baseline);
  next.defaultProvider = "beta";
  next.providers.alpha.defaultModel = "alpha-new";
  await act(async () => { editor!.setDraft(JSON.stringify(next, null, 2)); });

  let saved = false;
  await act(async () => { saved = await editor!.saveConfig(); });

  expect(saved).toBe(true);
  expect(requests).toEqual([{
    url: "/editor/api/providers",
    method: "PUT",
    body: { baseline, next },
  }]);
  expect(requests.some(request => request.url.endsWith("/api/config") && request.method === "PUT")).toBe(false);
  expect(requests.some(request => ["POST", "PATCH", "DELETE"].includes(request.method))).toBe(false);
  expect(configRefreshes).toBe(1);
  expect(quotaRefreshes).toBe(1);
  expect(savedCallbacks).toBe(1);
});

test("parse failures stay distinct from server failures and failed saves do not refresh", async () => {
  await mountHook();
  await act(async () => { editor!.openJsonEditor(); });
  await act(async () => { editor!.setDraft("{bad json"); });

  await act(async () => { expect(await editor!.saveConfig()).toBe(false); });
  expect(requests).toHaveLength(0);
  expect(notifications.at(-1)).toEqual({ message: "prov.invalidJson", ok: false });

  await act(async () => { editor!.restoreJsonEditor(); });
  responseFactory = async () => Response.json({ error: "stale baseline" }, { status: 409 });
  await act(async () => { expect(await editor!.saveConfig()).toBe(false); });

  expect(notifications.at(-1)).toEqual({ message: "stale baseline", ok: false });
  responseFactory = async () => { throw new Error("network down"); };
  await act(async () => { expect(await editor!.saveConfig()).toBe(false); });
  expect(notifications.at(-1)).toEqual({ message: "prov.saveFailed", ok: false });
  expect(configRefreshes).toBe(0);
  expect(quotaRefreshes).toBe(0);
  expect(savedCallbacks).toBe(0);
});
