import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import Startup from "../src/pages/Startup";
import { writeSessionListCache } from "../src/session-list-cache";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const API_BASE = "http://localhost";
const CACHE_KEY = `ocx.startup.page.v1:${API_BASE}`;

function atRiskHealth() {
  return {
    status: "at-risk",
    routingKind: "opencodex-local",
    routingInjected: true,
    localRoutingDependency: true,
    autostartEnabled: false,
    rebootSafe: false,
    protection: "none",
    serviceInstalled: false,
    serviceViable: false,
    serviceEnabled: false,
    serviceRunning: false,
    serviceStale: false,
    serviceConflict: false,
    serviceSupported: true,
    shimInstalled: false,
    shimHealthy: false,
    shimCoverage: "none",
    platform: "darwin",
    recommendedCommand: "ocx service install",
    diagnosticStale: false,
    commands: { installService: "ocx service install", repairService: "ocx service repair", installShim: "ocx shim install", restoreNative: "ocx restore" },
  };
}

function protectedHealth() {
  return { ...atRiskHealth(), status: "protected", protection: "service", serviceInstalled: true, serviceViable: true, serviceEnabled: true, serviceRunning: true, rebootSafe: true };
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  testWindow.sessionStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

// #1245: a failed install notice is a claim about one attempt. If the user then
// reaches that attempt's goal another way -- the CLI, the service manager, a retry
// the page did not initiate -- the refresh reports success while the stale failure
// keeps claiming otherwise, with no way to dismiss it.
//
// The clearing is scoped per action on purpose, and the second test pins that:
// `status` is overall restart safety, so a machine protected by the service must
// NOT erase a failed shim install, which is still true and still actionable.

// The two install buttons both read "Install"; only their aria-label
// distinguishes service from shim. Match the accessible name so a copy change
// cannot silently retarget the click.
function accessibleName(el: Element): string {
  return el.getAttribute("aria-label") ?? el.textContent ?? "";
}

function clickTarget(pattern: RegExp): HTMLButtonElement {
  const button = [...container().querySelectorAll("button")]
    .find(b => pattern.test(accessibleName(b)));
  if (!button) {
    const names = [...container().querySelectorAll("button")].map(accessibleName);
    throw new Error(`no button matching ${pattern}; saw: ${JSON.stringify(names)}`);
  }
  return button as unknown as HTMLButtonElement;
}

let containerEl: HTMLElement | null = null;
function container(): HTMLElement {
  if (!containerEl) throw new Error("container not mounted");
  return containerEl;
}

async function mount(health: () => Record<string, unknown>, onAction: () => Response) {
  const { createRoot } = await import("react-dom/client");
  containerEl = document.createElement("div");
  document.body.append(containerEl);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/settings")) return Response.json({ codexRuntime: {} });
    if (url.includes("/api/startup-action")) return onAction();
    if (url.includes("/api/startup-health")) return Response.json(health());
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(containerEl!);
    root.render(<LanguageProvider><Startup apiBase={API_BASE} /></LanguageProvider>);
  });
  await settle();
  return root;
}

// Drain the microtask queue and any zero-delay timers React scheduled, without
// betting on a fixed wall-clock duration.
async function settle() {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await new Promise<void>(r => testWindow.setTimeout(r, 0)); });
  }
}

test("a failed service install clears once the service is independently running (#1245)", async () => {
  let health = atRiskHealth();
  const root = await mount(() => health, () => Response.json({ error: "service install failed" }, { status: 500 }));

  await act(async () => {
    clickTarget(/service.*install/i).dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
  await settle();
  expect(container().textContent).toContain("service install failed");

  // The service comes up by some other route; the page refreshes.
  health = { ...atRiskHealth(), status: "protected", protection: "service", serviceInstalled: true, serviceViable: true, serviceEnabled: true, serviceRunning: true, rebootSafe: true };
  await act(async () => {
    clickTarget(/refresh/i).dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
  await settle();

  expect(container().textContent).not.toContain("service install failed");

  await act(async () => { root.unmount(); });
  containerEl!.remove();
  containerEl = null;
});

test("a failed shim install survives a refresh that only proves the service is healthy (#1245)", async () => {
  let health = atRiskHealth();
  const root = await mount(() => health, () => Response.json({ error: "shim install failed" }, { status: 500 }));

  await act(async () => {
    clickTarget(/shim.*install/i).dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
  await settle();
  expect(container().textContent).toContain("shim install failed");

  // Restart safety is now covered BY THE SERVICE. The shim is still not installed,
  // so the shim failure is still true — clearing it here would hide a real problem
  // behind an unrelated success.
  health = { ...atRiskHealth(), status: "protected", protection: "service", serviceInstalled: true, serviceViable: true, serviceEnabled: true, serviceRunning: true, rebootSafe: true };
  await act(async () => {
    clickTarget(/refresh/i).dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
  await settle();

  expect(container().textContent).toContain("shim install failed");

  await act(async () => { root.unmount(); });
  containerEl!.remove();
  containerEl = null;
});

test("a failed service repair survives a refresh where the service is still stale (#1245)", async () => {
  let health = { ...atRiskHealth(), serviceInstalled: true, serviceRunning: true, serviceStale: true, serviceViable: false };
  const root = await mount(() => health, () => Response.json({ error: "service repair failed" }, { status: 500 }));

  await act(async () => {
    clickTarget(/service.*repair/i).dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
  await settle();
  expect(container().textContent).toContain("service repair failed");

  // A stale or conflicting service can be installed AND running while the page
  // still reports it unhealthy. Installed-and-running is therefore not proof the
  // repair worked; serviceViable is what the UI itself treats as healthy.
  health = { ...health, serviceInstalled: true, serviceRunning: true, serviceStale: true, serviceViable: false };
  await act(async () => {
    clickTarget(/refresh/i).dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
  await settle();

  expect(container().textContent).toContain("service repair failed");

  await act(async () => { root.unmount(); });
  containerEl!.remove();
  containerEl = null;
});

test("a failed shim install on an already-native machine survives a native refresh (#1245)", async () => {
  // Native routing means no local routing dependency to protect, but the shim
  // Install button is still offered, so a failed optional shim install is still
  // true. Clearing on `native` alone would hide it.
  const nativeHealth = () => ({ ...atRiskHealth(), status: "native", routingKind: "native", routingInjected: false, localRoutingDependency: false, protection: "none", rebootSafe: true });
  const root = await mount(nativeHealth, () => Response.json({ error: "shim install failed" }, { status: 500 }));

  await act(async () => {
    clickTarget(/shim.*install/i).dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
  await settle();
  expect(container().textContent).toContain("shim install failed");

  await act(async () => {
    clickTarget(/refresh/i).dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
  await settle();

  expect(container().textContent).toContain("shim install failed");

  await act(async () => { root.unmount(); });
  containerEl!.remove();
  containerEl = null;
});

test("a failed install clears when the user restores native routing instead (#1245)", async () => {
  // The positive side of the routing-provenance branch. The attempt was made
  // while startup depended on the local proxy; restoring native routing removes
  // that dependency, so the install it was protecting is no longer outstanding
  // and its failure notice is obsolete.
  let health = atRiskHealth();
  const root = await mount(() => health, () => Response.json({ error: "service install failed" }, { status: 500 }));

  await act(async () => {
    clickTarget(/service.*install/i).dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
  await settle();
  expect(container().textContent).toContain("service install failed");

  health = { ...atRiskHealth(), status: "native", routingKind: "native", routingInjected: false, localRoutingDependency: false, protection: "none", rebootSafe: true };
  await act(async () => {
    clickTarget(/refresh/i).dispatchEvent(new testWindow.Event("click", { bubbles: true }));
  });
  await settle();

  expect(container().textContent).not.toContain("service install failed");

  await act(async () => { root.unmount(); });
  containerEl!.remove();
  containerEl = null;
});
