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
import { watchMacTitlebarMetrics } from "../src/lib/window-chrome";

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

test("macOS titlebar clearance follows page zoom and monitor scale", async () => {
  let monitorScale = 2;
  const calls: string[] = [];
  Object.defineProperty(win, "devicePixelRatio", { configurable: true, value: 2 });
  win.__TAURI__ = { core: { invoke: async (command) => {
    calls.push(command);
    return monitorScale;
  } } };
  const stop = watchMacTitlebarMetrics(host);
  await Promise.resolve();
  expect(host.style.getPropertyValue("--tl-inset")).toBe("80px");
  expect(host.style.getPropertyValue("--titlebar-h")).toBe("40px");
  expect(host.classList.contains("app--reduced-zoom")).toBe(false);

  // WKWebView pageZoom=0.2 on a Retina display reports DPR=0.4. The
  // controls stay in window points, so CSS clearance must grow fivefold.
  Object.defineProperty(win, "devicePixelRatio", { configurable: true, value: 0.4 });
  win.dispatchEvent(new win.Event("resize"));
  expect(host.style.getPropertyValue("--tl-inset")).toBe("400px");
  expect(host.style.getPropertyValue("--titlebar-h")).toBe("200px");
  expect(host.style.getPropertyValue("--chrome-clear")).toBe("620px");
  expect(host.classList.contains("app--reduced-zoom")).toBe(true);

  // Moving to a non-Retina monitor at the same zoom changes the native scale.
  monitorScale = 1;
  Object.defineProperty(win, "devicePixelRatio", { configurable: true, value: 0.2 });
  win.dispatchEvent(new win.Event("resize"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(host.style.getPropertyValue("--tl-inset")).toBe("400px");
  expect(calls).toContain("plugin:window|scale_factor");
  stop();
});

test("zooming in shrinks only the lights' clearance so the narrow menu stays on screen", async () => {
  win.__TAURI__ = { core: { invoke: async () => 2 } };
  // 300% page zoom on a Retina window: DPR 6, so one CSS pixel is a third of a point.
  Object.defineProperty(win, "devicePixelRatio", { configurable: true, value: 6 });
  const stop = watchMacTitlebarMetrics(host);
  await Promise.resolve();
  expect(host.style.getPropertyValue("--tl-inset")).toBe("27px");
  expect(host.style.getPropertyValue("--chrome-clear")).toBe("71px");
  expect(host.style.getPropertyValue("--titlebar-h")).toBe("40px");
  expect(host.classList.contains("app--reduced-zoom")).toBe(false);
  // A 360pt window at 300% is 120 CSS pixels: the inset plus the 44px menu must fit.
  expect(27 + 44).toBeLessThanOrEqual(120);
  stop();
});

test("the strip yields to the mobile header and still sizes the desktop Combos shell", () => {
  const css = readFileSync(new URL("../src/components/app-titlebar.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const mobile = css.slice(css.indexOf("@media (max-width: 760px)"));
  expect(mobile).toContain(".main-top { position: static; z-index: auto; }");
  expect(css).toContain(".main:has(> .main-top):has(> .main-inner--combos .combos-workspace-shell) {");
  expect(css).toContain(".main:has(> .main-top) > .main-inner.main-inner--combos:has(.combos-workspace-shell) {");
  expect(app).toContain('<header className="mobile-topbar" inert={navOpen} {...(desktopShell ? windowChromeHandlers() : {})}>');
});

test("the narrow macOS strip and drawer reserve the native controls", () => {
  const css = readFileSync(new URL("../src/components/app-titlebar.css", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../../desktop/src-tauri/src/lib.rs", import.meta.url), "utf8");
  const mobile = css.slice(css.indexOf("@media (max-width: 760px)"));
  expect(mobile).toContain(".app--macos .mobile-topbar { padding-left: var(--tl-inset, 80px); }");
  expect(mobile).toContain(".app--macos .sidebar.open { padding-top: calc(var(--titlebar-h, 40px) + 18px); }");
  expect(css).toContain("--sidebar-column: max(232px, calc(var(--tl-inset) + 52px))");
  expect(css).toContain(".app--macos.app--reduced-zoom { transition: none; }");
  expect(css).toContain(".app--macos .mobile-topbar { flex-wrap: wrap; }");
  expect(lib).toContain(".min_inner_size(360.0, 320.0)");
});
