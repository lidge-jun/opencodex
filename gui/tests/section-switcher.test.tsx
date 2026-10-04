import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Page } from "../src/app-routing";
import { SectionSwitcher, type SectionSwitcherItem } from "../src/components/SectionSwitcher";
import { NAV_GROUPS, visibleGroupPages } from "../src/nav-groups";

/*
 * The switcher's contract: page navigation (a named nav, aria-current on the current
 * page), arrow keys along the row, focus that survives the page change it causes, and
 * focus that lands on a survivor when the focused member disappears. App's placement
 * outside the keyed boundary is pinned in sidebar-rows.test.ts.
 */

const domGlobals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(domGlobals.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  win = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  for (const k of domGlobals) {
    const d = previous[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
  await win.happyDOM?.close?.();
});

const CONNECT: SectionSwitcherItem[] = [
  { page: "claude", label: "Claude" },
  { page: "integrations", label: "Integrations" },
  { page: "remote", label: "Remote Link" },
  { page: "remote-workspace", label: "Remote Workspace" },
];

async function render(items: readonly SectionSwitcherItem[], currentPage: Page, onNavigate: (page: Page) => void = () => {}) {
  const { createRoot } = await import("react-dom/client");
  if (!root) {
    const host = win.document.createElement("div");
    win.document.body.appendChild(host as never);
    root = createRoot(host as never);
  }
  await act(async () => {
    root!.render(<SectionSwitcher items={items} currentPage={currentPage} onNavigate={onNavigate} ariaLabel="Section pages" />);
  });
}

const buttons = () => [...win.document.querySelectorAll<HTMLButtonElement>(".section-switcher-btn")];
const focusedLabel = () => (win.document.activeElement as HTMLElement | null)?.textContent ?? null;

test("renders a named nav with only the current page marked", async () => {
  await render(CONNECT, "integrations");
  const nav = win.document.querySelector("nav.section-switcher");
  expect(nav?.getAttribute("aria-label")).toBe("Section pages");
  expect(buttons().map(b => b.getAttribute("aria-current"))).toEqual([null, "page", null, null]);
  // Navigation, not tabs: no tablist semantics to collide with the pages' own strips.
  expect(win.document.querySelector('[role="tablist"]')).toBeNull();
});

test("click navigates to another member and ignores the current one", async () => {
  const calls: Page[] = [];
  await render(CONNECT, "claude", page => calls.push(page));
  await act(async () => buttons()[0]!.click());
  await act(async () => buttons()[2]!.click());
  expect(calls).toEqual(["remote"]);
});

test("arrow keys, Home and End move focus along the row and wrap", async () => {
  await render(CONNECT, "claude");
  const press = async (key: string) => {
    await act(async () => {
      win.document.activeElement!.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true }) as never);
    });
  };
  buttons()[0]!.focus();
  await press("ArrowRight");
  expect(focusedLabel()).toBe("Integrations");
  await press("End");
  expect(focusedLabel()).toBe("Remote Workspace");
  await press("ArrowRight");
  expect(focusedLabel()).toBe("Claude");
  await press("ArrowLeft");
  expect(focusedLabel()).toBe("Remote Workspace");
  await press("Home");
  expect(focusedLabel()).toBe("Claude");
});

test("the activated button keeps focus across the page change it causes", async () => {
  let current: Page = "usage";
  const items: SectionSwitcherItem[] = [
    { page: "usage", label: "Usage" },
    { page: "logs", label: "Logs" },
    { page: "storage", label: "Storage" },
  ];
  await render(items, current, page => { current = page; });
  buttons()[1]!.focus();
  await act(async () => buttons()[1]!.click());
  await render(items, current);
  expect(current).toBe("logs");
  expect(focusedLabel()).toBe("Logs");
  expect(buttons()[1]!.getAttribute("aria-current")).toBe("page");
});

test("focus moves to a survivor when the focused member disappears", async () => {
  await render(CONNECT, "remote");
  buttons()[3]!.focus();
  expect(focusedLabel()).toBe("Remote Workspace");
  await render(CONNECT.slice(0, 3), "remote");
  expect(buttons()).toHaveLength(3);
  // The current page's button is the natural place to land.
  expect(focusedLabel()).toBe("Remote Link");
});

test("Remote offers Remote Workspace only while it is available; Connect has no switcher", () => {
  const remote = NAV_GROUPS.find(group => group.id === "remote")!;
  expect(visibleGroupPages(remote, { remoteWorkspaceAvailable: false })).toEqual(["remote"]);
  expect(visibleGroupPages(remote, { remoteWorkspaceAvailable: true })).toEqual(["remote", "remote-workspace"]);
  // Claude is embedded in Connect, so Connect never has more than one switcher member.
  const connect = NAV_GROUPS.find(group => group.id === "connect")!;
  expect(visibleGroupPages(connect, { remoteWorkspaceAvailable: true })).toEqual(["integrations"]);
  const usageLogs = NAV_GROUPS.find(group => group.id === "usage-logs")!;
  expect(visibleGroupPages(usageLogs, { remoteWorkspaceAvailable: false })[0]).toBe("usage");
});
