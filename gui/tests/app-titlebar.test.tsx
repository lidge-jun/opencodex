/**
 * The integrated title bar's collapse toggle: the sidebar shrinks to a rail that keeps
 * the traffic lights and the toggle, the answer is persisted, and Cmd/Ctrl+B flips it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SidebarTopStrip } from "../src/components/app-titlebar";
import { useSidebarCollapse } from "../src/use-sidebar-collapse";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "HTMLElement", "Element", "IS_REACT_ACT_ENVIRONMENT"] as const;
const WINDOW_EVENT_STUB: { event: undefined } = { event: undefined };
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

function Probe() {
  const { collapsed, toggle } = useSidebarCollapse();
  return (
    <div className={`app${collapsed ? " app--nav-collapsed" : ""}`}>
      <aside id="app-sidebar" className="sidebar">
        <SidebarTopStrip collapsed={collapsed} onToggle={toggle} />
        <nav />
      </aside>
    </div>
  );
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win, "event", { configurable: true, writable: true, value: undefined });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    HTMLElement: { configurable: true, value: win.HTMLElement },
    Element: { configurable: true, value: win.Element },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((r) => setTimeout(r, 0));
      await Promise.resolve();
    }
  });
  for (const key of globals) {
    let value = previous[key];
    if (key === "window") {
      if (value == null || typeof value !== "object") {
        value = WINDOW_EVENT_STUB;
      } else if (!Object.prototype.hasOwnProperty.call(value, "event")) {
        try {
          Object.defineProperty(value, "event", { configurable: true, writable: true, value: undefined });
        } catch {
          value = WINDOW_EVENT_STUB;
        }
      }
    }
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});

async function mountProbe() {
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
  });
  return host.querySelector(".app")!;
}

test("the toggle collapses the sidebar to its rail and persists the choice", async () => {
  const app = await mountProbe();
  expect(app.className).not.toContain("app--nav-collapsed");

  const toggle = host.querySelector(".sidebar-collapse") as HTMLButtonElement;
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-controls")).toBe("app-sidebar");
  // Icon-only control: the accessible name is the i18n label, not icon internals.
  expect(toggle.getAttribute("aria-label")).toBe("Collapse sidebar");

  await act(async () => { toggle.click(); });
  expect(app.className).toContain("app--nav-collapsed");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-label")).toBe("Expand sidebar");
  expect(win.localStorage.getItem("ocx-sidebar-collapsed")).toBe("1");
});

test("a stored collapse survives remount", async () => {
  win.localStorage.setItem("ocx-sidebar-collapsed", "1");
  const app = await mountProbe();
  expect(app.className).toContain("app--nav-collapsed");
});

test("Cmd/Ctrl+B toggles the rail and skips text fields", async () => {
  const app = await mountProbe();
  const press = (init: { key: string; metaKey?: boolean; ctrlKey?: boolean }) =>
    win.dispatchEvent(new win.KeyboardEvent("keydown", { ...init, bubbles: true }));

  await act(async () => { press({ key: "b", metaKey: true }); });
  expect(app.className).toContain("app--nav-collapsed");

  await act(async () => { press({ key: "b", ctrlKey: true }); });
  expect(app.className).not.toContain("app--nav-collapsed");

  // A bare B and an editable target must both be ignored.
  const input = win.document.createElement("input");
  win.document.body.appendChild(input as never);
  await act(async () => { press({ key: "b" }); });
  expect(app.className).not.toContain("app--nav-collapsed");
  await act(async () => {
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
  });
  expect(app.className).not.toContain("app--nav-collapsed");
});
