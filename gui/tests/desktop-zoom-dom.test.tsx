import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DesktopZoomControl } from "../src/components/desktop-zoom-control";
import { LanguageProvider } from "../src/i18n/provider";
import { ZOOM_MAX, ZOOM_STORAGE_KEY } from "../src/lib/desktop-zoom";
import { useDesktopZoom } from "../src/use-desktop-zoom";

/**
 * The remembered level actually reaches the webview: applied on mount (so a restart or a page
 * navigation cannot leave the window at a level the dashboard does not know), moved by the
 * shortcut, and written back. Rendered against a stand-in shell that records its commands.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const LINUX_SHELL = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) OpenCodexDesktop/2.75.0";

let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let root: Root | null = null;
let calls: Array<{ command: string; args?: Record<string, unknown> }> = [];

function Probe({ managed }: { managed: boolean }) {
  const zoom = useDesktopZoom({ managed });
  return <DesktopZoomControl percent={zoom.percent} canZoomIn={zoom.canZoomIn} canZoomOut={zoom.canZoomOut} onStep={zoom.step} />;
}

function mount(node: React.ReactElement, saved?: string) {
  win = new Window({ url: "http://127.0.0.1:10100/", settings: { navigator: { userAgent: LINUX_SHELL } } });
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  calls = [];
  if (saved !== undefined) win.localStorage.setItem(ZOOM_STORAGE_KEY, saved);
  Reflect.set(win, "__TAURI_INTERNALS__", {
    invoke: (command: string, args?: Record<string, unknown>) => { calls.push({ command, args }); return Promise.resolve(); },
  });
  // Plain assignment fails in a whole-suite run: an earlier DOM test leaves `document`
  // installed as a non-writable global, so only defineProperty works. `writable` stays on so
  // this file never does the same to the tests that run after it (several of them assign
  // `localStorage` and `navigator` directly).
  Object.defineProperties(globalThis, {
    document: { configurable: true, writable: true, value: win.document },
    window: { configurable: true, writable: true, value: win },
    navigator: { configurable: true, writable: true, value: win.navigator },
    localStorage: { configurable: true, writable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  const host = win.document.createElement("div") as never as HTMLElement;
  win.document.body.appendChild(host as never);
  act(() => { root = createRoot(host); root.render(<LanguageProvider>{node}</LanguageProvider>); });
  return host;
}

function press(init: KeyboardEventInit) {
  const event = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { win.dispatchEvent(event); });
  return event;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  for (const k of globals) Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: previous?.[k] });
});

const zoomCalls = () => calls.filter(call => call.command === "plugin:webview|set_webview_zoom").map(call => call.args?.value);

test("the remembered level is applied when the dashboard starts", () => {
  const el = mount(<Probe managed />, "1.3");
  expect(zoomCalls()).toEqual([1.3]);
  expect(el.querySelector(".zoom-control__value")?.textContent).toBe("130%");
});

test("a first start applies 100%, so the webview and the dashboard agree", () => {
  mount(<Probe managed />);
  expect(zoomCalls()).toEqual([1]);
});

test("Ctrl plus steps up from the remembered level, applies it and saves it", () => {
  const el = mount(<Probe managed />, "1.3");
  const event = press({ key: "=", ctrlKey: true });
  expect(event.defaultPrevented).toBe(true);
  expect(zoomCalls()).toEqual([1.3, 1.4]);
  expect(win.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe("1.4");
  expect(el.querySelector(".zoom-control__value")?.textContent).toBe("140%");
});

test("Ctrl zero returns to 100%", () => {
  mount(<Probe managed />, "1.7");
  press({ key: "0", ctrlKey: true });
  expect(zoomCalls().at(-1)).toBe(1);
  expect(win.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe("1");
});

test("the sidebar buttons step and reset the same level", () => {
  const el = mount(<Probe managed />, "1");
  const [out, , plus] = Array.from(el.querySelectorAll("button")) as never as HTMLElement[];
  act(() => { plus!.click(); });
  act(() => { plus!.click(); });
  act(() => { out!.click(); });
  expect(zoomCalls()).toEqual([1, 1.1, 1.2, 1.1]);
  act(() => { (el.querySelector(".zoom-control__value") as never as HTMLElement).click(); });
  expect(zoomCalls().at(-1)).toBe(1);
});

test("the plus button disables at the ceiling", () => {
  const el = mount(<Probe managed />, String(ZOOM_MAX));
  const plus = el.querySelectorAll("button")[2] as never as HTMLButtonElement;
  expect(plus.disabled).toBe(true);
});

test("outside the managed hosts nothing is applied or intercepted", () => {
  mount(<Probe managed={false} />, "1.3");
  const event = press({ key: "=", ctrlKey: true });
  expect(event.defaultPrevented).toBe(false);
  expect(zoomCalls()).toEqual([]);
  expect(win.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe("1.3");
});
