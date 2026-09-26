/**
 * The integrated title bar's collapse toggle: the sidebar leaves the layout and its top
 * strip — traffic lights and the toggle — stays; the answer is persisted, and Cmd/Ctrl+B
 * flips it when the desktop shell opts the shortcut in.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

function Probe({ shortcut = false }: { shortcut?: boolean }) {
  const { collapsed, toggle } = useSidebarCollapse({ shortcut });
  return (
    <div className={`app${collapsed ? " app--nav-collapsed" : ""}`}>
      {/* Mirrors App.tsx: the strip is an .app child, not a sidebar child, so the
         collapsed sidebar cannot clip it. */}
      <SidebarTopStrip collapsed={collapsed} onToggle={toggle} />
      <aside id="app-sidebar" className="sidebar">
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

async function mountProbe(shortcut = false) {
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <Probe shortcut={shortcut} />
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
  const app = await mountProbe(true);
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

test("the shortcut stays off in the plain browser shell", async () => {
  const app = await mountProbe();
  await act(async () => {
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }));
  });
  expect(app.className).not.toContain("app--nav-collapsed");
});

test("the traffic-light position and the CSS row stay in step", () => {
  // desktop/src-tauri/src/lib.rs parks the lights with `traffic_light_position`; the
  // strips' height and the lights inset live in app-titlebar.css. Drift between them
  // puts the lights on top of the toggle — this is the check for that.
  const lib = readFileSync(new URL("../../desktop/src-tauri/src/lib.rs", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/components/app-titlebar.css", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const position = lib.match(/traffic_light_position\(\s*tauri::Position::Logical\(\s*tauri::LogicalPosition::new\(\s*([\d.]+),\s*([\d.]+)/);
  expect(position).not.toBeNull();
  const [lightX, lightY] = [Number(position![1]), Number(position![2])];
  const inset = Number(css.match(/--tl-inset:\s*(\d+)px/)?.[1]);
  const row = Number(css.match(/--titlebar-h:\s*(\d+)px/)?.[1]);
  const clear = Number(css.match(/\.app--macos\s*\{\s*--chrome-clear:\s*(\d+)px/)?.[1]);
  // 52px of lights + 10px of air after the lead inset; the collapsed indent clears
  // inset + toggle (28px) + padding (16px).
  expect(inset).toBe(lightX + 52 + 10);
  // Measured on-device: tao treats y like a container inset, not the buttons' top
  // edge — the light centers land ~2px BELOW y. Verified center = row/2 at y=22.
  expect(row).toBe(2 * (lightY - 2));
  expect(clear).toBeGreaterThanOrEqual(inset + 28 + 16);
  // The expanded strip floats over exactly the sidebar column (.app's first grid track).
  const column = Number(styles.match(/\.app\s*\{[^}]*grid-template-columns:\s*(\d+)px/)?.[1]);
  const stripWidth = Number(css.match(/\.sidebar-top\s*\{[^}]*width:\s*(\d+)px/)?.[1]);
  expect(stripWidth).toBe(column);
});
