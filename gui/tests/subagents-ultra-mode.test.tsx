import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let v2Responses: Array<{ ok: boolean; body: unknown; status?: number }> = [];
let v2Call = 0;
let requests: Array<{ url: string; init?: RequestInit }> = [];
const recommendation = { text: "server-supplied proactive policy", revision: "test-policy-v1" };

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
      if (path === "/api/subagent-model-fallback") return response({ available: [], models: [], pollMs: 60_000 });
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
  const { createRoot } = await import("react-dom/client");
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
    .find(candidate => candidate.getAttribute("aria-label") === "Always proactive delegation");
  if (!button) throw new Error("Always proactive delegation switch not found");
  return button as HTMLButtonElement;
}

test("does not enable Ultra mode for the default surface even when V2 is enabled", async () => {
  v2Responses = [{ ok: true, body: { enabled: true, multiAgentMode: "default", multiAgentModeHintText: null, multiAgentModeHintRecommendation: recommendation } }];
  await mount();

  expect(ultraSwitch().disabled).toBe(true);
  expect(ultraSwitch().getAttribute("aria-pressed")).toBe("false");
});

test("clears the page load error after a successful Ultra mode retry", async () => {
  v2Responses = [
    { ok: false, body: { error: "temporary failure" }, status: 503 },
    { ok: true, body: { enabled: true, multiAgentMode: "v2", multiAgentModeHintText: null, multiAgentModeHintRecommendation: recommendation } },
  ];
  await mount();

  expect(container.textContent).toContain("Failed to load proactive delegation settings");
  const ultraErrorRow = Array.from(container.querySelectorAll(".swi-delegation-row"))
    .find(row => row.textContent?.includes("Failed to load proactive delegation settings"));
  const retry = ultraErrorRow?.querySelector<HTMLButtonElement>("button");
  expect(retry).toBeTruthy();

  await act(async () => { retry!.click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

  expect(v2Call).toBe(2);
  expect(container.textContent).not.toContain("Failed to load proactive delegation settings");
  expect(ultraSwitch().disabled).toBe(false);
});

test("enabling Ultra mode uses the server-supplied recommendation", async () => {
  v2Responses = [{ ok: true, body: { enabled: true, multiAgentMode: "v2", multiAgentModeHintText: null, multiAgentModeHintRecommendation: recommendation } }];
  await mount();

  await act(async () => { ultraSwitch().click(); });

  const request = requests.find(item => item.init?.method === "PUT" && new URL(item.url, "http://localhost/").pathname === "/api/v2");
  expect(JSON.parse(String(request?.init?.body))).toEqual({ multiAgentModeHintText: recommendation.text });
});

test("an older server without a recommendation disables only preset installation", async () => {
  v2Responses = [{ ok: true, body: { enabled: true, multiAgentMode: "v2", multiAgentModeHintText: null } }];
  await mount();

  expect(ultraSwitch().disabled).toBe(true);
  expect(ultraSwitch().getAttribute("aria-pressed")).toBe("false");
});

test.each([
  { text: "", revision: "r1" },
  { text: "valid", revision: " " },
  { text: 42, revision: "r1" },
])("malformed server recommendations cannot install a preset: %j", async malformed => {
  v2Responses = [{ ok: true, body: {
    enabled: true, multiAgentMode: "v2", multiAgentModeHintText: null,
    multiAgentModeHintRecommendation: malformed,
  } }];
  await mount();

  expect(ultraSwitch().disabled).toBe(true);
  await act(async () => { ultraSwitch().click(); });
  expect(requests.filter(item => item.init?.method === "PUT")).toHaveLength(0);
});

test("an older server preserves an existing custom hint and still allows clearing it", async () => {
  v2Responses = [{ ok: true, body: { enabled: true, multiAgentMode: "v2", multiAgentModeHintText: "custom policy" } }];
  await mount();

  expect(ultraSwitch().disabled).toBe(false);
  expect(ultraSwitch().getAttribute("aria-pressed")).toBe("true");
  await act(async () => { ultraSwitch().click(); });

  const request = requests.find(item => item.init?.method === "PUT" && new URL(item.url, "http://localhost/").pathname === "/api/v2");
  expect(JSON.parse(String(request?.init?.body))).toEqual({ multiAgentModeHintText: null });
});

test.each([undefined, { text: "", revision: "r1" }])("custom hints remain editable without a valid recommendation: %j", async unavailable => {
  v2Responses = [{ ok: true, body: {
    enabled: true, multiAgentMode: "v2", multiAgentModeHintText: "custom policy",
    multiAgentModeHintRecommendation: unavailable,
  } }];
  await mount();
  const editor = container.querySelector(".swi-ultra-mode-editor")!;
  const textarea = editor.querySelector("textarea")!;
  const restore = [...editor.querySelectorAll("button")].find(button => button.textContent?.trim() === "Restore preset")!;
  const save = [...editor.querySelectorAll("button")].find(button => button.textContent?.trim() === "Save")!;
  const custom = "  my custom policy\nwith a preserved trailing space ";
  expect(restore.disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, custom);
    textarea.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  expect(requests.filter(item => item.init?.method === "PUT")).toHaveLength(0);
  await act(async () => { save.click(); });
  const puts = requests.filter(item => item.init?.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(JSON.parse(String(puts[0].init?.body))).toEqual({ multiAgentModeHintText: custom });
});

test("a custom hint loads without writing and restore stays local until Save", async () => {
  v2Responses = [{ ok: true, body: {
    enabled: true,
    multiAgentMode: "v2",
    multiAgentModeHintText: "custom policy",
    multiAgentModeHintRecommendation: recommendation,
  } }];
  await mount();

  const editor = container.querySelector(".swi-ultra-mode-editor");
  const textarea = editor?.querySelector("textarea") as HTMLTextAreaElement | null;
  const restore = Array.from(editor?.querySelectorAll("button") ?? [])
    .find(button => button.textContent?.trim() === "Restore preset");
  const save = Array.from(editor?.querySelectorAll("button") ?? [])
    .find(button => button.textContent?.trim() === "Save");

  expect(textarea?.value).toBe("custom policy");
  expect(requests.filter(item => item.init?.method === "PUT")).toHaveLength(0);

  await act(async () => { (restore as HTMLButtonElement).click(); });
  expect(textarea?.value).toBe(recommendation.text);
  expect(requests.filter(item => item.init?.method === "PUT")).toHaveLength(0);

  await act(async () => { (save as HTMLButtonElement).click(); });
  const put = requests.find(item => item.init?.method === "PUT" && new URL(item.url, "http://localhost/").pathname === "/api/v2");
  expect(JSON.parse(String(put?.init?.body))).toEqual({ multiAgentModeHintText: recommendation.text });
});

test.each([
  ["missing", undefined],
  ["malformed", { text: "", revision: "b1" }],
  ["valid", { text: "server-B policy", revision: "b1" }],
] as const)("server switches cannot install or restore another server's preset (%s)", async (_kind, nextRecommendation) => {
  let releaseNext!: (value: Response) => void;
  const nextRead = new Promise<Response>(resolve => { releaseNext = resolve; });
  const nextState = {
    enabled: true, multiAgentMode: "v2", multiAgentModeHintText: null,
    multiAgentModeHintRecommendation: nextRecommendation,
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const path = new URL(String(url), "http://localhost/").pathname;
      if (path === "/old/api/v2") return response({
        enabled: true, multiAgentMode: "v2", multiAgentModeHintText: "custom-A policy",
        multiAgentModeHintRecommendation: recommendation,
      });
      if (path === "/new/api/v2") return init?.method === "PUT" ? response(nextState) : nextRead;
      if (path.endsWith("/api/subagent-models")) return response({ available: [], chosen: [] });
      if (path.endsWith("/api/subagent-model-fallback")) return response({ available: [], models: [], pollMs: 60_000 });
      if (path.endsWith("/api/injection-model")) return response({ available: [], efforts: [] });
      return response({});
    },
  });
  await mount("/old");
  expect(container.querySelector<HTMLTextAreaElement>(".swi-ultra-mode-editor textarea")?.value).toBe("custom-A policy");
  await act(async () => { root!.render(<LanguageProvider><Subagents apiBase="/new" /></LanguageProvider>); });

  expect(ultraSwitch().disabled).toBe(true);
  expect(container.querySelector(".swi-ultra-mode-editor")).toBeNull();
  await act(async () => { ultraSwitch().click(); });
  expect(requests.filter(item => item.init?.method === "PUT")).toHaveLength(0);

  await act(async () => { releaseNext(response(nextState)); await nextRead; });
  const valid = Boolean(nextRecommendation?.text);
  expect(ultraSwitch().disabled).toBe(!valid);
  await act(async () => { ultraSwitch().click(); });
  const puts = requests.filter(item => item.init?.method === "PUT");
  if (valid) {
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe("/new/api/v2");
    expect(JSON.parse(String(puts[0]?.init?.body))).toEqual({ multiAgentModeHintText: nextRecommendation!.text });
  } else {
    expect(puts).toHaveLength(0);
  }
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
        if (oldGets === 1) return response({ enabled: true, multiAgentMode: "v2", multiAgentModeHintText: null, multiAgentModeHintRecommendation: recommendation });
        return oldRefresh;
      }
      if (path === "/new/api/v2") return response({ enabled: false, multiAgentMode: "default", multiAgentModeHintText: null });
      if (path.endsWith("/api/subagent-models")) return response({ available: [], chosen: [] });
      if (path.endsWith("/api/subagent-model-fallback")) return response({ available: [], models: [], pollMs: 60_000 });
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
    releaseOldRefresh(response({ enabled: true, multiAgentMode: "v2", multiAgentModeHintText: recommendation.text, multiAgentModeHintRecommendation: recommendation }));
    await oldRefresh;
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  expect(ultraSwitch().disabled).toBe(true);
  expect(ultraSwitch().getAttribute("aria-pressed")).toBe("false");
});
