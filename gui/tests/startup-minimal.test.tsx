import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Startup from "../src/pages/Startup";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";

/**
 * devlog/_plan/260904_dashboard_minimal/070_startup.md: the hero answers the page's
 * question and carries the one-line state + the explanatory sentence (visible, not a
 * title); the three stat cards and the back button are gone; the copyable recovery
 * commands sit behind a details that is open only while protection is missing.
 */
const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

function health(status: "protected" | "at-risk") {
  const safe = status === "protected";
  return {
    status, routingKind: "opencodex-local", routingInjected: true, localRoutingDependency: true,
    autostartEnabled: safe, rebootSafe: safe, protection: safe ? "service" : "none",
    serviceInstalled: safe, serviceViable: safe, serviceEnabled: safe, serviceRunning: safe,
    serviceStale: false, serviceConflict: false, serviceSupported: true,
    shimInstalled: safe, shimHealthy: safe, shimCoverage: safe ? "full" : "none", platform: "darwin",
    recommendedCommand: "ocx service install", diagnosticStale: false,
    commands: { installService: "ocx service install", repairService: "ocx service repair", installShim: "ocx shim install", restoreNative: "ocx restore" },
  };
}

function response(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
}

let status: "protected" | "at-risk" = "protected";

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#startup" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (url: string) => {
      const path = new URL(String(url), "http://localhost/").pathname;
      if (path === "/api/startup-health") return response(health(status));
      if (path === "/api/settings") return response({ codexAutoStart: true, codexRuntime: { version: "x" } });
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

async function mount() {
  root = createRoot(container);
  await act(async () => { root!.render(<LanguageProvider><Startup apiBase="http://localhost" /></LanguageProvider>); });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 30)); });
}

test("protected: hero carries the state line and the sentence; no stat grid, no back button; recovery details closed", async () => {
  status = "protected";
  await mount();
  expect(container.querySelector(".startup-state-grid")).toBeNull();
  expect([...container.querySelectorAll("button")].map(b => b.textContent?.trim())).not.toContain("Back to Dashboard");
  const hero = container.querySelector(".startup-hero")!;
  expect(hero.querySelector(".startup-state-line")?.textContent).toContain("·");
  // The old subtitle is a visible sentence inside the hero, not a title attribute.
  expect(hero.textContent).toContain("Verify that Codex can reach opencodex");
  expect(container.querySelector('[title*="Verify that Codex"]')).toBeNull();
  const details = container.querySelector<HTMLDetailsElement>("details.startup-recovery-details")!;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  // Commands are still there, one click away.
  expect(details.textContent).toContain("ocx shim install");
});

test("at-risk: recovery details open by default", async () => {
  status = "at-risk";
  await mount();
  const details = container.querySelector<HTMLDetailsElement>("details.startup-recovery-details")!;
  expect(details.open).toBe(true);
});
