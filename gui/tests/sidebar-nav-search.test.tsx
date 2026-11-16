import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useState } from "react";
import type { Root } from "react-dom/client";
import { SidebarNav } from "../src/components/sidebar-nav";
import type { Page } from "../src/app-routing";
import type { TFn } from "../src/i18n/shared";

const globals = ["document", "window", "navigator", "HTMLElement", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let win: Window;
let root: Root;
let host: HTMLDivElement;
let navigated: Page[];

beforeEach(async () => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/" });
  for (const key of globals) {
    const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "requestAnimationFrame" || key === "cancelAnimationFrame" ? win[key].bind(win) : Reflect.get(win, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  navigated = [];
  host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  function Harness() {
    const [drawer, setDrawer] = useState(true);
    useEffect(() => {
      const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(false); };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, []);
    return <><input aria-label="outside" /><div data-drawer={drawer ? "open" : "closed"}><SidebarNav
      activeGroupId={null} pageLabel={page => page} pageAvailable={page => page !== "remote-workspace"}
      onNavigate={page => navigated.push(page)} onReveal={() => setDrawer(true)} desktopShell={false}
      t={((key: string) => key) as TFn} /></div></>;
  }
  await act(async () => { root = createRoot(host); root.render(<Harness />); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
});
function key(target: Element, name: string, options: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; code?: string } = {}) {
  const event = new win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event as unknown as Event);
  return event;
}
async function frame() { await new Promise(resolve => setTimeout(resolve, 25)); }
async function open() {
  const trigger = host.querySelector<HTMLButtonElement>(".nav-search-open")!;
  trigger.focus();
  await act(async () => { trigger.click(); await frame(); });
  return host.querySelector<HTMLInputElement>(".nav-search-input")!;
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
}

test("named modal contains focus and Escape closes only search, then restores focus", async () => {
  const input = await open();
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog?.getAttribute("aria-modal")).toBe("true");
  expect(dialog.getAttribute("aria-label")).toBe("shellV2.navSearch");
  expect(document.activeElement === input).toBe(true);
  expect(input.getAttribute("role")).toBe("combobox");
  expect(document.getElementById(input.getAttribute("aria-controls")!)).not.toBeNull();
  const close = dialog.querySelector<HTMLButtonElement>(".nav-search-close")!;
  const outside = host.querySelector<HTMLInputElement>('[aria-label="outside"]')!;
  expect(outside.hasAttribute("inert")).toBe(true);
  await act(async () => { outside.focus(); });
  expect(document.activeElement === input).toBe(true);
  expect(key(input, "Tab", { ctrlKey: true }).defaultPrevented).toBe(false);
  await act(async () => { key(input, "Tab", { shiftKey: true }); });
  expect(document.activeElement === close).toBe(true);
  await act(async () => { key(close, "Tab"); });
  expect(document.activeElement === input).toBe(true);
  await act(async () => { key(close, "Escape"); });
  await act(async () => { await frame(); });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(outside.hasAttribute("inert")).toBe(false);
  expect(host.querySelector("[data-drawer]")?.getAttribute("data-drawer")).toBe("open");
  expect(document.activeElement === host.querySelector(".nav-search-open")).toBe(true);
  await act(async () => { key(document.activeElement!, "Escape"); });
  expect(host.querySelector("[data-drawer]")?.getAttribute("data-drawer")).toBe("closed");
});

test("search result selection uses valid active descendant and arrow keys", async () => {
  const input = await open();
  await type(input, "logs");
  const options = host.querySelectorAll<HTMLElement>('[role="option"]');
  expect(options.length).toBeGreaterThan(1);
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!) === options[0]).toBe(true);
  await act(async () => { key(input, "ArrowDown"); });
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!) === options[1]).toBe(true);
  await act(async () => { key(input, "ArrowUp"); });
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!) === options[0]).toBe(true);
  expect(key(input, "ArrowDown", { altKey: true }).defaultPrevented).toBe(false);
  await act(async () => { key(input, "ArrowDown"); });
  await act(async () => { key(input, "Enter"); });
  expect(navigated).toEqual(["logs"]);
});

test("editable slash and browser tab shortcuts are untouched; shortcut focus is restored", async () => {
  const outside = host.querySelector<HTMLInputElement>('[aria-label="outside"]')!;
  outside.focus();
  await act(async () => { expect(key(outside, "/").defaultPrevented).toBe(false); });
  expect(host.querySelector(".nav-search-input")).toBeNull();
  await act(async () => { expect(key(outside, "1", { ctrlKey: true, code: "Digit1" }).defaultPrevented).toBe(false); });
  expect(navigated).toEqual([]);
  await act(async () => { key(outside, "k", { ctrlKey: true }); await frame(); });
  const input = host.querySelector<HTMLInputElement>(".nav-search-input")!;
  expect(input).not.toBeNull();
  await act(async () => { key(input, "Escape"); });
  await act(async () => { await frame(); });
  expect(document.activeElement === outside).toBe(true);
});

test("empty results retain a valid listbox and close button restores its trigger", async () => {
  host.querySelector<HTMLInputElement>('[aria-label="outside"]')!.focus();
  await act(async () => { host.querySelector<HTMLButtonElement>(".nav-search-open")!.click(); });
  await act(async () => { await frame(); });
  const input = host.querySelector<HTMLInputElement>(".nav-search-input")!;
  await type(input, "no-such-page");
  expect(input.getAttribute("aria-activedescendant")).toBeNull();
  expect(document.getElementById(input.getAttribute("aria-controls")!)?.getAttribute("role")).toBe("listbox");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("shellV2.navSearchEmpty");
  await type(input, "");
  expect(host.querySelector('[data-group="home"]')?.closest("[inert]")).not.toBeNull();
  await act(async () => { host.querySelector<HTMLButtonElement>(".nav-search-close")!.click(); });
  await act(async () => { await frame(); });
  expect(document.activeElement === host.querySelector(".nav-search-open")).toBe(true);
});

test("Escape during drawer reveal closes search before the drawer", async () => {
  await act(async () => { key(host.querySelector<HTMLInputElement>('[aria-label="outside"]')!, "k", { ctrlKey: true }); });
  await act(async () => { win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.querySelector("[data-drawer]")?.getAttribute("data-drawer")).toBe("open");
});
