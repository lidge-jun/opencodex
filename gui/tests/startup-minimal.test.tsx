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
let desktop = false;
let desktopViable = true;
let brokenStarters = false;
/** Replaces the default owned Desktop facts; null keeps the owned fixture above. */
let desktopFacts: Record<string, unknown> | null = null;
let staleReading = false;
let healthFails = false;
let releaseInstall: (() => void) | null = null;

beforeEach(() => {
  desktop = false;
  desktopViable = true;
  brokenStarters = false;
  desktopFacts = null;
  staleReading = false;
  healthFails = false;
  releaseInstall = null;
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
      if (path === "/api/startup-health" && healthFails) {
        return { ok: false, status: 500, text: async () => "{}", json: async () => ({ error: "probe failed" }) } as unknown as Response;
      }
      if (path === "/api/startup-action") {
        await new Promise<void>(resolve => { releaseInstall = resolve; });
        return response({ ok: true });
      }
      if (path === "/api/startup-health") return response(desktop ? {
        ...health(desktopViable ? "protected" : "at-risk"), protection: desktopViable ? "desktop" : "none", serviceInstalled: false, serviceViable: false,
        shimInstalled: brokenStarters, shimHealthy: false, serviceInstalled: brokenStarters, serviceStale: brokenStarters,
        diagnosticStale: staleReading,
        desktop: desktopFacts ?? { owned: true, loginEnabled: desktopViable, running: desktopViable, viable: desktopViable },
      } : health(status));
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

test("desktop protection is named separately and cannot install a competing service", async () => {
  desktop = true;
  await mount();
  expect(container.querySelector(".startup-state-line")?.textContent).toContain("Desktop app");
  expect(container.querySelector(".startup-details")?.textContent).toContain("desktop app supervises");
  const install = container.querySelector<HTMLButtonElement>('button[aria-label="Background service - Install"]');
  expect(install).not.toBeNull();
  expect(install!.disabled).toBe(true);
});

test("non-viable desktop ownership blocks competing starters and gives desktop recovery", async () => {
  desktop = true;
  desktopViable = false;
  await mount();
  const install = container.querySelector<HTMLButtonElement>('button[aria-label="Background service - Install"]');
  expect(install).not.toBeNull();
  expect(install!.disabled).toBe(true);
  const shim = container.querySelector<HTMLButtonElement>('button[aria-label="Codex launcher shim - Install"]');
  expect(shim!.disabled).toBe(true);
  const recovery = container.querySelector(".startup-recovery-details")!;
  expect(recovery.textContent).toContain("Start at Login");
  expect(recovery.textContent).not.toContain("ocx service install");
  expect(recovery.textContent).not.toContain("ocx shim install");
  expect(recovery.textContent).not.toContain("background service is recommended");
  expect(recovery.textContent).toContain("ocx restore");
  expect(container.querySelector(".startup-hero")!.textContent).toContain("Start at Login");
});

test("desktop ownership also blocks repair of stale service and shim assets", async () => {
  desktop = true;
  desktopViable = false;
  brokenStarters = true;
  await mount();
  for (const label of ["Background service - Repair", "Codex launcher shim - Repair"]) {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(true);
  }
});

test("a CLI-owned unprotected install still offers service and shim actions", async () => {
  status = "at-risk";
  await mount();
  for (const label of ["Background service - Install", "Codex launcher shim - Install"]) {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
  }
});

const SUPERVISOR = { supervisorPid: 123, runtimePid: 456, app: "/Applications/OpenCodex.app/Contents/MacOS/opencodex-desktop" };

function desktopBadge(): string {
  const row = [...container.querySelectorAll(".startup-details .startup-detail-row")]
    .find(item => item.textContent?.includes("Desktop app"));
  return row?.querySelector(".badge")?.textContent ?? "";
}

test("#6963: a supervised Desktop running without verified Start at Login names the missing login item", async () => {
  desktop = true;
  desktopViable = false;
  desktopFacts = { owned: false, supervisor: SUPERVISOR, loginEnabled: false, running: true, viable: false };
  await mount();
  expect(desktopBadge()).toBe("Running · Start at Login not verified");
  const details = container.querySelector(".startup-details")!.textContent!;
  expect(details).toContain("Login Items & Extensions");
  expect(details).not.toContain("Installed but unhealthy");
  // Startup management stays with the app: neither starter can be installed here.
  for (const label of ["Background service - Install", "Codex launcher shim - Install"]) {
    expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.disabled).toBe(true);
  }
});

test("#6963: an owned Desktop running without Start at Login gets the same badge and keeps owned guidance", async () => {
  desktop = true;
  desktopViable = false;
  desktopFacts = { owned: true, loginEnabled: false, running: true, viable: false };
  await mount();
  expect(desktopBadge()).toBe("Running · Start at Login not verified");
  const details = container.querySelector(".startup-details")!.textContent!;
  expect(details).toContain("OpenCodex owns this proxy");
  // The owned guidance names the macOS allowance too, matching the badge.
  expect(details).toContain("Login Items & Extensions");
});

test("#6963: a stopped Desktop and a stale reading stay unhealthy; a verified Desktop is ready", async () => {
  desktop = true;
  desktopViable = false;
  await mount();
  expect(desktopBadge()).toBe("Installed but unhealthy");
  await act(async () => { root!.unmount(); });
  root = null;
  clearClientResourceStoresForTests();

  desktopFacts = { owned: false, supervisor: SUPERVISOR, loginEnabled: false, running: true, viable: false };
  staleReading = true;
  await mount();
  expect(desktopBadge()).toBe("Installed but unhealthy");
  await act(async () => { root!.unmount(); });
  root = null;
  clearClientResourceStoresForTests();

  desktopViable = true;
  staleReading = false;
  desktopFacts = { owned: false, supervisor: SUPERVISOR, loginEnabled: true, running: true, viable: true };
  await mount();
  expect(desktopBadge()).toBe("Ready");
});

test("#6963: a failed refresh that keeps the last Desktop reading does not claim it is running", async () => {
  desktop = true;
  desktopViable = false;
  desktopFacts = { owned: false, supervisor: SUPERVISOR, loginEnabled: false, running: true, viable: false };
  await mount();
  expect(desktopBadge()).toBe("Running · Start at Login not verified");
  healthFails = true;
  const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("Refresh"))!;
  await act(async () => { refresh.click(); });
  await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 30)); });
  expect(container.querySelector(".startup-details")).not.toBeNull();
  expect(desktopBadge()).toBe("Installed but unhealthy");
});

test("an in-flight install disables every starter action until it settles", async () => {
  status = "at-risk";
  await mount();
  const shim = container.querySelector<HTMLButtonElement>('button[aria-label="Codex launcher shim - Install"]')!;
  expect(shim.disabled).toBe(false);
  await act(async () => { shim.click(); });
  for (const label of ["Background service - Install", "Codex launcher shim - Install"]) {
    expect(container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.disabled).toBe(true);
  }
  await act(async () => { releaseInstall?.(); await new Promise<void>(r => testWindow.setTimeout(r, 30)); });
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Background service - Install"]')!.disabled).toBe(false);
});
