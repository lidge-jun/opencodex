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

function mount(node: React.ReactElement, saved?: string, beforeRender?: () => void) {
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
  // The shell injects its polyfill when the document is created, so anything that stands in for it
  // is registered here, before the dashboard has rendered and registered its own listeners.
  beforeRender?.();
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

/**
 * Tauri's zoom polyfill is injected into the page before the dashboard runs and listens on
 * `window` in the bubble phase. Events from the page start at an element, so the real path is
 * element, then window. Registration order matters: the polyfill's listeners exist first, so a
 * dashboard listener that merely stops propagation in the bubble phase would run too late. Call
 * this through `mount`'s `beforeRender` so the stand-in is registered the way the shell's is.
 */
function installPolyfillStandIn() {
  const seen = { keydown: [] as string[], mousewheel: 0 };
  win.addEventListener("keydown", (event) => { seen.keydown.push((event as KeyboardEvent).key); });
  win.addEventListener("mousewheel", () => { seen.mousewheel += 1; });
  return seen;
}

function pressOnPage(init: KeyboardEventInit) {
  const event = new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => { win.document.body.dispatchEvent(event); });
  return event;
}

function wheelOnPage(type: "wheel" | "mousewheel", init: WheelEventInit) {
  const event = new win.WheelEvent(type, { bubbles: true, cancelable: true, ...init });
  // happy-dom's WheelEvent drops the modifier flags from its init (a browser keeps them), so the
  // flag the handlers read is set on the instance.
  Object.defineProperty(event, "ctrlKey", { value: init.ctrlKey === true });
  act(() => { win.document.body.dispatchEvent(event); });
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

/**
 * Version skew between the shell and the dashboard it is showing (PR review). The dashboard is
 * served by the runtime and the shell is the installed app, so they are not always the same
 * version: a declined takeover leaves the app attached to an older runtime, and an app update
 * leaves the shell newer than a service that has not restarted. The polyfill is injected by the
 * shell, so a dashboard that handles zoom has to be the only writer without the shell's help,
 * and a dashboard that does not must leave the polyfill working.
 */
test("a newer dashboard is the only zoom writer even when the shell injects its polyfill", () => {
  let polyfill!: ReturnType<typeof installPolyfillStandIn>;
  mount(<Probe managed />, "1.3", () => { polyfill = installPolyfillStandIn(); });
  const event = pressOnPage({ key: "=", ctrlKey: true });
  expect(zoomCalls()).toEqual([1.3, 1.4]);
  expect(polyfill.keydown).toEqual([]);
  expect(event.defaultPrevented).toBe(true);
});

test("an older dashboard that does not manage zoom leaves the polyfill working", () => {
  let polyfill!: ReturnType<typeof installPolyfillStandIn>;
  mount(<Probe managed={false} />, "1.3", () => { polyfill = installPolyfillStandIn(); });
  const event = pressOnPage({ key: "=", ctrlKey: true });
  expect(polyfill.keydown).toEqual(["="]);
  expect(event.defaultPrevented).toBe(false);
  expect(zoomCalls()).toEqual([]);
});

test("keys that are not zoom keys still reach the rest of the page", () => {
  let polyfill!: ReturnType<typeof installPolyfillStandIn>;
  mount(<Probe managed />, undefined, () => { polyfill = installPolyfillStandIn(); });
  pressOnPage({ key: "b", ctrlKey: true });
  pressOnPage({ key: "=" });
  expect(polyfill.keydown).toEqual(["b", "="]);
});

test("the polyfill's Alt variants cannot sneak a second write past the dashboard", () => {
  let polyfill!: ReturnType<typeof installPolyfillStandIn>;
  mount(<Probe managed />, "1", () => { polyfill = installPolyfillStandIn(); });
  pressOnPage({ key: "-", ctrlKey: true, altKey: true });
  expect(polyfill.keydown).toEqual([]);
  expect(zoomCalls().at(-1)).toBe(0.9);
});

test("Ctrl + wheel is taken by the dashboard and the legacy mousewheel event is silenced too", () => {
  let polyfill!: ReturnType<typeof installPolyfillStandIn>;
  mount(<Probe managed />, "1", () => { polyfill = installPolyfillStandIn(); });
  wheelOnPage("wheel", { ctrlKey: true, deltaY: -120 });
  wheelOnPage("mousewheel", { ctrlKey: true, deltaY: -120 });
  expect(zoomCalls()).toEqual([1, 1.1]);
  expect(polyfill.mousewheel).toBe(0);
});

test("a wheel turn without Ctrl scrolls the page and reaches every listener", () => {
  let polyfill!: ReturnType<typeof installPolyfillStandIn>;
  mount(<Probe managed />, "1", () => { polyfill = installPolyfillStandIn(); });
  const event = wheelOnPage("mousewheel", { deltaY: -120 });
  expect(polyfill.mousewheel).toBe(1);
  expect(event.defaultPrevented).toBe(false);
  expect(zoomCalls()).toEqual([1]);
});
