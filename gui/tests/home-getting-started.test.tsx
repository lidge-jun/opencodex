import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Home from "../src/pages/Home";
import SetupHub from "../src/pages/SetupHub";

/*
 * Getting started inside the OpenCodex desktop app (devlog/_plan/261121_desktop_getting_started_hide).
 * The app's install and first run turn Start at Login on, so its checklist has no such step; the
 * browser dashboard keeps it. The card can be hidden, and the Set up hub brings it back.
 */

const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) OpenCodexDesktop/2.100.6";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36";
const names = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

let saved: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | undefined;

// The app's own reading: Start at Login is off, which the browser dashboard would list as to do.
const startupOff = {
  status: "at-risk", routingKind: "opencodex-local", routingInjected: true, localRoutingDependency: true,
  autostartEnabled: false, rebootSafe: false, protection: "none",
  serviceInstalled: false, serviceViable: false, serviceEnabled: false, serviceRunning: false,
  serviceStale: false, serviceConflict: false, serviceSupported: true,
  shimInstalled: false, shimHealthy: false, shimCoverage: "none", platform: "darwin",
  recommendedCommand: null, diagnosticStale: false,
  commands: { installService: "ocx service install", repairService: "ocx service repair", installShim: "ocx shim install", restoreNative: "ocx restore" },
  desktop: { owned: true, loginEnabled: false, loginState: "disabled", running: true, viable: false },
};

function install(userAgent: string) {
  win = new Window({ url: "http://localhost/#home", settings: { navigator: { userAgent } } });
  win.localStorage.setItem("ocx-lang", "en");
  for (const name of names.filter(value => value !== "fetch")) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(win, name) });
  }
}

beforeEach(() => {
  saved = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  install(BROWSER_UA);
  clearClientResourceStoresForTests();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost/").pathname;
    if (path === "/api/startup-health") return Response.json(startupOff);
    // One provider is set up and nothing has been sent yet: the first step is done.
    if (path === "/api/config") return Response.json({ providers: { openai: {} } });
    if (path === "/api/usage") return Response.json({ summary: { requests: 0, totalTokens: 0 } });
    if (path === "/api/logs") return Response.json({ logs: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  await unmount();
  clearClientResourceStoresForTests();
  win.close();
  for (const name of names) {
    if (saved[name]) Object.defineProperty(globalThis, name, saved[name]!);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function desktop() {
  win.close();
  install(DESKTOP_UA);
}

async function unmount() {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  document.body.innerHTML = "";
}

async function mount(node: ReactNode): Promise<HTMLElement> {
  await unmount();
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

const home = () => mount(<Home apiBase="http://getting-started" navigate={() => {}} onReloadCodex={() => {}} reloadingCodex={false} />);
const setupHub = () => mount(<SetupHub apiBase="http://getting-started" navigate={() => {}} />);

function headings(host: HTMLElement): string[] {
  return [...host.querySelectorAll("h2")].map(heading => heading.textContent ?? "");
}

function stepTitles(host: HTMLElement): string[] {
  return [...host.querySelectorAll("li[data-step]")].map(row => (row as HTMLElement).dataset.step ?? "");
}

function button(host: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].find(candidate =>
    (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === name) as HTMLButtonElement | undefined;
}

async function click(target: HTMLButtonElement) {
  await act(async () => {
    target.click();
    await new Promise(resolve => setTimeout(resolve, 10));
  });
}

test("the desktop app's Home lists two steps and never asks for Start at Login", async () => {
  desktop();
  const host = await home();
  expect(headings(host)).toContain("Getting started");
  expect(host.textContent).toContain("1 of 2 done");
  expect(stepTitles(host)).toEqual(["provider", "request"]);
  expect(host.textContent).not.toContain("Turn on Start at Login");
});

test("the desktop app's Set up hub drops the same step", async () => {
  desktop();
  const host = await setupHub();
  expect(stepTitles(host)).toEqual(["provider", "apps", "request"]);
  expect(host.textContent).toContain("1 of 3 done");
  expect(host.textContent).not.toContain("Turn on Start at Login");
});

test("the browser dashboard keeps its Start at Login step", async () => {
  const homeHost = await home();
  expect(stepTitles(homeHost)).toEqual(["provider", "request", "autostart"]);
  expect(homeHost.textContent).toContain("1 of 3 done");
  expect(homeHost.textContent).toContain("Turn on Start at Login");
  const hubHost = await setupHub();
  expect(stepTitles(hubHost)).toEqual(["provider", "apps", "request", "autostart"]);
  expect(hubHost.textContent).toContain("1 of 4 done");
});

test("Hide removes only Getting started, offers Undo, and is remembered on the next visit", async () => {
  const host = await home();
  const hide = button(host, "Hide Getting started");
  expect(hide?.textContent?.trim()).toBe("Hide");
  await click(hide!);

  expect(headings(host)).not.toContain("Getting started");
  expect(headings(host)).toContain("Recent errors");
  expect(host.textContent).toContain("Requests · 7 days");
  // The note names where the Set up hub lives in the sidebar: the Checklist tab under Route.
  expect(host.textContent).toContain("Getting started is hidden. You can show it again from Route → Checklist.");
  expect(button(host, "Undo")).toBeDefined();
  // Focus lands on Undo instead of falling to the page body with the removed button.
  expect(document.activeElement).toBe(button(host, "Undo") ?? null);

  const again = await home();
  expect(headings(again)).not.toContain("Getting started");
  expect(headings(again)).toContain("Recent errors");
  expect(again.textContent).not.toContain("Getting started is hidden.");
});

test("Undo puts Getting started back", async () => {
  const host = await home();
  await click(button(host, "Hide Getting started")!);
  await click(button(host, "Undo")!);
  expect(headings(host)).toContain("Getting started");
  expect(host.textContent).not.toContain("Getting started is hidden.");
  expect(document.activeElement).toBe(button(host, "Hide Getting started") ?? null);
  const again = await home();
  expect(headings(again)).toContain("Getting started");
});

test("a change made in another window reaches an open Home without taking focus", async () => {
  const host = await home();
  const other = document.createElement("button");
  document.body.append(other);
  other.focus();
  await act(async () => {
    win.localStorage.setItem("ocx-home-getting-started-hidden", "1");
    win.dispatchEvent(new win.StorageEvent("storage", { key: "ocx-home-getting-started-hidden", newValue: "1", storageArea: win.localStorage }));
  });
  expect(headings(host)).not.toContain("Getting started");
  expect(host.textContent).not.toContain("Getting started is hidden.");
  expect(document.activeElement).toBe(other as unknown as Element);
  await act(async () => {
    win.localStorage.removeItem("ocx-home-getting-started-hidden");
    win.dispatchEvent(new win.StorageEvent("storage", { key: "ocx-home-getting-started-hidden", newValue: null, storageArea: win.localStorage }));
  });
  expect(headings(host)).toContain("Getting started");
});

test("the Set up hub shows Getting started on Home again", async () => {
  const visible = await setupHub();
  expect(button(visible, "Show on Home")).toBeUndefined();

  await click(button(await home(), "Hide Getting started")!);
  const hub = await setupHub();
  expect(hub.textContent).toContain("Getting started is hidden on Home.");
  await click(button(hub, "Show on Home")!);
  expect(button(hub, "Show on Home")).toBeUndefined();
  expect(hub.textContent).toContain("Getting started is back on Home.");
  // The clicked button is gone, so focus moves to the confirmation that replaced it.
  expect(document.activeElement?.textContent).toBe("Getting started is back on Home.");

  const again = await home();
  expect(headings(again)).toContain("Getting started");
});

test("the desktop app can hide and restore Getting started too", async () => {
  desktop();
  await click(button(await home(), "Hide Getting started")!);
  expect(headings(await home())).not.toContain("Getting started");
  await click(button(await setupHub(), "Show on Home")!);
  expect(headings(await home())).toContain("Getting started");
});

test("a browser that refuses storage still hides the card for this visit", async () => {
  Object.defineProperty(win.localStorage, "setItem", { configurable: true, value: () => { throw new Error("quota"); } });
  const host = await home();
  await click(button(host, "Hide Getting started")!);
  expect(headings(host)).not.toContain("Getting started");
  expect(headings(host)).toContain("Recent errors");
  // Moving to the Set up hub and back keeps the choice, and Show on Home still works.
  const hub = await setupHub();
  await click(button(hub, "Show on Home")!);
  expect(headings(await home())).toContain("Getting started");
});

test("a browser that refuses to read storage shows the card", async () => {
  Object.defineProperty(win.localStorage, "getItem", { configurable: true, value: () => { throw new Error("denied"); } });
  const host = await home();
  expect(headings(host)).toContain("Getting started");
  expect(headings(host)).toContain("Recent errors");
});

test("a browser that writes storage but refuses to read it still hides and restores the card", async () => {
  Object.defineProperty(win.localStorage, "getItem", { configurable: true, value: () => { throw new Error("denied"); } });
  const host = await home();
  await click(button(host, "Hide Getting started")!);
  expect(headings(host)).not.toContain("Getting started");
  expect(button(host, "Undo")).toBeDefined();
  const hub = await setupHub();
  await click(button(hub, "Show on Home")!);
  expect(headings(await home())).toContain("Getting started");
});

test("clearing session storage elsewhere keeps a choice that could not be saved", async () => {
  Object.defineProperty(win.localStorage, "setItem", { configurable: true, value: () => { throw new Error("quota"); } });
  const host = await home();
  await click(button(host, "Hide Getting started")!);
  await act(async () => {
    win.dispatchEvent(new win.StorageEvent("storage", { key: null, storageArea: win.sessionStorage }));
  });
  expect(headings(host)).not.toContain("Getting started");
});
