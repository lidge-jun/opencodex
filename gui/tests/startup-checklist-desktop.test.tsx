import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Home from "../src/pages/Home";
import SetupHub from "../src/pages/SetupHub";
import Startup from "../src/pages/Startup";
import * as routing from "../src/app-routing";
import * as ui from "../src/startup-health-ui";

/*
 * Getting started step 3 under OpenCodex Desktop (devlog/_plan/261110_desktop_autostart_checklist).
 * The app keeps the proxy alive through Start at Login, so the step's copy, completion and
 * destination follow the Desktop reading; every browser reading keeps the original step.
 */

const names = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let saved: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;
let health: unknown;

function install(url: string) {
  win = new Window({ url });
  win.localStorage.setItem("ocx-lang", "en");
  for (const name of names.filter(value => value !== "fetch")) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(win, name) });
  }
}

beforeEach(() => {
  saved = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  install("http://localhost/#home");
  clearClientResourceStoresForTests();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    if (path === "/api/startup-health") return Response.json(typeof health === "function" ? (health as () => unknown)() : health);
    if (path === "/api/config") return Response.json({ providers: {} });
    if (path === "/api/logs") return Response.json({ logs: [] });
    if (path === "/api/settings") return Response.json({ codexAutoStart: true, codexRuntime: { version: "x" } });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  clearClientResourceStoresForTests();
  win.close();
  for (const name of names) {
    if (saved[name]) Object.defineProperty(globalThis, name, saved[name]!);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const commands = { installService: "ocx service install", repairService: "ocx service repair", installShim: "ocx shim install", restoreNative: "ocx restore" };
function reading(overrides: Record<string, unknown>) {
  return {
    status: "at-risk", routingKind: "opencodex-local", routingInjected: true, localRoutingDependency: true,
    autostartEnabled: false, rebootSafe: false, protection: "none",
    serviceInstalled: false, serviceViable: false, serviceEnabled: false, serviceRunning: false,
    serviceStale: false, serviceConflict: false, serviceSupported: true,
    shimInstalled: false, shimHealthy: false, shimCoverage: "none", platform: "darwin",
    recommendedCommand: null, diagnosticStale: false, commands,
    ...overrides,
  };
}
const supervisor = { supervisorPid: 41, runtimePid: 42, app: "/Applications/OpenCodex.app" };
const fixtures = {
  macOn: reading({ status: "protected", rebootSafe: true, protection: "desktop", desktop: { owned: true, loginEnabled: true, loginState: "enabled", running: true, viable: true } }),
  macOff: reading({ desktop: { owned: true, loginEnabled: false, loginState: "disabled", running: true, viable: false } }),
  macUnknown: reading({ desktop: { owned: true, loginEnabled: false, loginState: "unknown", running: true, viable: false } }),
  macStale: reading({ diagnosticStale: true, desktop: { owned: true, loginEnabled: true, loginState: "enabled", running: true, viable: true } }),
  macSupervisionUnknown: reading({ desktop: { owned: true, loginEnabled: true, loginState: "enabled", running: false, viable: false, supervisionUnknown: true } }),
  macStoppedNative: reading({ status: "native", routingKind: "native", localRoutingDependency: false, desktop: { owned: true, loginEnabled: true, loginState: "enabled", running: false, viable: false } }),
  macStoppedLocal: reading({ desktop: { owned: true, loginEnabled: true, loginState: "enabled", running: false, viable: false } }),
  macOffWithStarters: reading({ protection: "shim", shimInstalled: true, shimHealthy: true, serviceInstalled: true, desktop: { owned: true, loginEnabled: false, loginState: "disabled", running: true, viable: false } }),
  winSupervised: reading({ platform: "win32", desktop: { owned: false, loginEnabled: false, loginState: "unknown", running: true, viable: false, supervisor } }),
  winOwnedStopped: reading({ platform: "win32", desktop: { owned: true, loginEnabled: false, loginState: "unknown", running: false, viable: false } }),
  linuxClosed: reading({ platform: "linux", desktop: { owned: true, loginEnabled: true, loginState: "enabled", running: false, viable: false } }),
  browserService: reading({ status: "protected", rebootSafe: true, protection: "service", serviceInstalled: true, serviceViable: true }),
  browserShim: reading({ protection: "shim", shimInstalled: true, shimHealthy: true }),
  browserNone: reading({}),
} as const;

const DESKTOP_TITLE = "Turn on Start at Login";
const DESKTOP_HINT = "In the OpenCodex app menu, make sure Start at Login is checked.";
const BROWSER_TITLE = "Start automatically";
const BROWSER_HINT = "Keep opencodex running after a restart";

const cases: Array<[keyof typeof fixtures, boolean | undefined, boolean]> = [
  ["macOn", true, true],
  ["macOff", false, true],
  ["macUnknown", undefined, true],
  ["macStale", undefined, true],
  ["macSupervisionUnknown", undefined, true],
  ["macStoppedNative", false, true],
  ["macStoppedLocal", false, true],
  ["macOffWithStarters", false, true],
  ["winSupervised", undefined, true],
  ["winOwnedStopped", undefined, true],
  ["linuxClosed", undefined, true],
  ["browserService", true, false],
  ["browserShim", true, false],
  ["browserNone", false, false],
];

test("one shared step decides Desktop copy, completion and destination", () => {
  const step = (ui as Record<string, unknown>).startupChecklistStep as ((data: unknown) => { desktop: boolean; done: boolean | undefined; titleKey: string; hintKey: string; subPath?: string }) | undefined;
  expect(typeof step).toBe("function");
  for (const [name, done, desktop] of cases) {
    const result = step!(fixtures[name]);
    expect({ name, done: result.done, desktop: result.desktop }).toEqual({ name, done, desktop });
    expect(result.titleKey).toBe(desktop ? "shellV2.stepAutostartDesktop" : "shellV2.stepAutostart");
    expect(result.hintKey).toBe(desktop ? "shellV2.stepAutostartDesktopHint" : "shellV2.stepAutostartHint");
    expect(result.subPath).toBe(desktop ? "desktop" : undefined);
    if (!desktop) expect(result.done).toBe(ui.startupChecklistDone(fixtures[name]));
  }
  expect(step!(undefined).done).toBeUndefined();
  expect(step!(null).done).toBeUndefined();
});

async function mount(node: ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider>{node}</LanguageProvider>);
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  return host;
}

function autostartRow(host: HTMLElement): HTMLElement {
  const row = [...host.querySelectorAll("li")].find(li => li.dataset.step === "autostart"
    || li.textContent?.includes(BROWSER_TITLE) || li.textContent?.includes(DESKTOP_TITLE));
  if (!row) throw new Error("no autostart row");
  return row as HTMLElement;
}

for (const [name, done, desktop] of cases.filter(([name]) => ["macOn", "macOff", "macUnknown", "winSupervised", "browserService", "browserNone"].includes(name))) {
  test("Home shows the " + name + " step with its copy, state and destination", async () => {
    health = fixtures[name];
    const calls: unknown[][] = [];
    const host = await mount(<Home apiBase="http://checklist" navigate={(...args) => { calls.push(args); }} onReloadCodex={() => {}} reloadingCodex={false} />);
    const row = autostartRow(host);
    expect(row.dataset.step).toBe("autostart");
    expect(row.textContent).toContain(desktop ? DESKTOP_TITLE : BROWSER_TITLE);
    expect(row.textContent?.includes("✓")).toBe(done === true);
    // Unknown Desktop login still says where to look; the browser step keeps its hint for "to do" only.
    expect(row.textContent?.includes(desktop ? DESKTOP_HINT : BROWSER_HINT)).toBe(desktop ? done !== true : done === false);
    await act(async () => { row.querySelector("button")!.click(); });
    expect(calls).toEqual([desktop ? ["startup", "desktop"] : ["startup"]]);
  });

  test("SetupHub shows the " + name + " step with its copy, state and destination", async () => {
    health = fixtures[name];
    const calls: unknown[][] = [];
    const host = await mount(<SetupHub apiBase="http://checklist" navigate={(...args) => { calls.push(args); }} />);
    const row = autostartRow(host);
    expect(row.dataset.step).toBe("autostart");
    expect(row.textContent).toContain(desktop ? DESKTOP_TITLE : BROWSER_TITLE);
    expect(row.textContent).toContain(desktop ? DESKTOP_HINT : BROWSER_HINT);
    expect(row.textContent?.includes("Done")).toBe(done === true);
    expect(row.textContent?.includes("To do")).toBe(done === false);
    await act(async () => { row.querySelector("button")!.click(); });
    expect(calls).toEqual([desktop ? ["startup", "desktop"] : ["startup"]]);
  });
}

test("Home never shows a Desktop hint before the reading arrives", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => String(input).includes("/api/startup-health")
    ? new Promise<Response>(() => {}) : Response.json({ providers: {}, logs: [] })) as typeof fetch;
  const host = await mount(<Home apiBase="http://checklist-pending" navigate={() => {}} onReloadCodex={() => {}} reloadingCodex={false} />);
  const row = autostartRow(host);
  expect(row.textContent).not.toContain(DESKTOP_HINT);
  expect(row.textContent).not.toContain("✓");
});

test("the router keeps #startup/desktop on the Startup page", () => {
  expect(routing.hashBelongsToPage("startup/desktop", "startup")).toBe(true);
  expect(routing.resolveAppHashChange("startup/desktop")).toEqual({ page: "startup", replaceTo: null });
  expect(routing.hashBelongsToPage("startup/other", "startup")).toBe(false);
});

async function mountStartup(url: string): Promise<HTMLElement> {
  win.close();
  install(url);
  return mount(<Startup apiBase="http://localhost" />);
}

function desktopCard(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>('[data-option="desktop"]')!;
}

test("arriving at #startup/desktop focuses the Desktop card once it renders", async () => {
  health = fixtures.macOff;
  const host = await mountStartup("http://localhost/#startup/desktop");
  const card = desktopCard(host);
  expect(card).not.toBeNull();
  expect(document.activeElement).toBe(card);
  expect(card.tabIndex).toBe(-1);
  expect(win.location.hash).toBe("#startup/desktop");
});

test("a later refresh does not take focus back, and a new arrival focuses again", async () => {
  let reads = 0;
  health = () => ++reads === 1 ? { ...fixtures.macOff, diagnosticStale: true } : fixtures.macOff;
  const host = await mountStartup("http://localhost/#startup/desktop");
  const other = document.createElement("button");
  host.append(other);
  other.focus();
  // Wait for Startup's stale retry (2 s) instead of racing a fixed sleep against it.
  for (let waited = 0; reads < 2 && waited < 6000; waited += 100) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  }
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(reads).toBe(2);
  expect(document.activeElement).toBe(other);
  await act(async () => {
    win.location.hash = "#startup";
    win.location.hash = "#startup/desktop";
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  expect(document.activeElement).toBe(desktopCard(host));
});

test("#startup/desktop without a Desktop card does nothing", async () => {
  health = fixtures.browserService;
  const host = await mountStartup("http://localhost/#startup/desktop");
  expect(desktopCard(host)).toBeNull();
  expect(document.activeElement).toBe(document.body);
  expect(win.location.hash).toBe("#startup/desktop");
});

test("plain #startup leaves focus alone", async () => {
  health = fixtures.macOff;
  const host = await mountStartup("http://localhost/#startup");
  expect(desktopCard(host)).not.toBeNull();
  expect(document.activeElement).toBe(document.body);
});

test("a stopped Desktop card carries its next action", async () => {
  health = fixtures.macStoppedLocal;
  const host = await mountStartup("http://localhost/#startup/desktop");
  expect(desktopCard(host).textContent).toContain("Reopen OpenCodex and check Start at Login.");
});

