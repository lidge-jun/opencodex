import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Subagents from "../src/pages/Subagents";
import Startup from "../src/pages/Startup";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

/**
 * devlog/_plan/260904_dashboard_minimal/020_dashboard_home.md: two dashboard cards were not
 * removed but rehomed, atomically in the same phase so a landed 020 has no capability gap:
 * the Codex-autostart switch (Startup, next to the shim it configures) and the effort caps
 * (Subagents, with the other delegation settings). These tests pin that each new home reads
 * its endpoint on mount and writes it on change.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let requests: Array<{ url: string; method: string; body: unknown }> = [];
let multiAgentMode: "v1" | "default" | "v2" = "default";

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
}

function protectedHealth() {
  return {
    status: "protected", routingKind: "opencodex-local", routingInjected: true, localRoutingDependency: true,
    autostartEnabled: true, rebootSafe: true, protection: "service", serviceInstalled: true, serviceViable: true,
    serviceEnabled: true, serviceRunning: true, serviceStale: false, serviceConflict: false, serviceSupported: true,
    shimInstalled: true, shimHealthy: true, shimCoverage: "full", platform: "darwin",
    recommendedCommand: "ocx service install", diagnosticStale: false,
    commands: { installService: "ocx service install", repairService: "ocx service repair", installShim: "ocx shim install", restoreNative: "ocx restore" },
  };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  let autostart = true;
  let caps = { effortCap: "", subagentEffortCap: "" };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url: String(url), method, body });
      const path = new URL(String(url), "http://localhost/").pathname;
      if (path === "/api/settings") {
        if (method === "PUT") { autostart = body.codexAutoStart; }
        return response({ codexAutoStart: autostart, codexRuntime: { version: "x" } });
      }
      if (path === "/api/startup-health") return response(protectedHealth());
      if (path === "/api/effort-caps") {
        if (method === "PUT") caps = { ...caps, ...body };
        return response({ ok: true, ...caps });
      }
      if (path === "/api/v2") return response({ enabled: false, multiAgentMode, multiAgentModeHintText: null });
      if (path === "/api/subagent-models") return response({ available: [], chosen: [] });
      if (path === "/api/injection-model") return response({ available: [], efforts: [] });
      return response({});
    },
  });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  clearClientResourceStoresForTests();
});

const settle = async () => { await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 30)); }); };

test("Startup renders the autostart switch and PUTs /api/settings on toggle", async () => {
  root = createRoot(container);
  await act(async () => { root!.render(<LanguageProvider><Startup apiBase="http://localhost" /></LanguageProvider>); });
  await settle();
  const sw = container.querySelector<HTMLButtonElement>('button[aria-label="Start opencodex with Codex"]');
  expect(sw).not.toBeNull();
  expect(sw!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => { sw!.click(); });
  await settle();
  const put = requests.find(r => r.method === "PUT" && r.url.endsWith("/api/settings"));
  expect(put?.body).toEqual({ codexAutoStart: false });
  expect(sw!.getAttribute("aria-pressed")).toBe("false");
});

test("Subagents renders the effort caps outside v1 and PUTs /api/effort-caps on change", async () => {
  multiAgentMode = "default";
  root = createRoot(container);
  await act(async () => { root!.render(<LanguageProvider><Subagents apiBase="http://localhost" /></LanguageProvider>); });
  await settle();
  expect(requests.some(r => r.method === "GET" && r.url.endsWith("/api/effort-caps"))).toBe(true);
  const section = container.querySelector(".swi-effort-caps");
  expect(section).not.toBeNull();
  const trigger = section!.querySelector<HTMLButtonElement>('button[aria-label="V2 ultra effort limit"]');
  expect(trigger).not.toBeNull();
  await act(async () => { trigger!.click(); });
  await settle();
  const option = Array.from(testWindow.document.querySelectorAll<HTMLElement>('[role="option"]')).find(o => o.textContent?.trim() === "low");
  expect(option).toBeDefined();
  await act(async () => { option!.click(); });
  await settle();
  const put = requests.find(r => r.method === "PUT" && r.url.endsWith("/api/effort-caps"));
  expect(put?.body).toEqual({ effortCap: "low" });
});

test("Subagents hides the effort caps in v1", async () => {
  multiAgentMode = "v1";
  root = createRoot(container);
  await act(async () => { root!.render(<LanguageProvider><Subagents apiBase="http://localhost" /></LanguageProvider>); });
  await settle();
  expect(container.querySelector(".swi-effort-caps")).toBeNull();
  expect(requests.some(r => r.url.endsWith("/api/effort-caps"))).toBe(false);
});
