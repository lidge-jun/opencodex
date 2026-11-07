import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OpenBrowserPrefToggle } from "../src/components/open-browser-pref-toggle";
import { LanguageProvider } from "../src/i18n/provider";
import { openBrowserRequestField } from "../src/oauth-open-browser-pref";

const keys = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof keys)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  win.close();
  for (const key of keys) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("browser-open preference is an accessible switch and persists the inverse choice", () => {
  win = new Window({ url: "http://localhost/" });
  previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const host = win.document.createElement("div");
  win.document.body.append(host);
  act(() => { root = createRoot(host as unknown as HTMLElement); root.render(<LanguageProvider><OpenBrowserPrefToggle /></LanguageProvider>); });
  const input = host.querySelector<HTMLInputElement>('input[role="switch"]')!;
  expect(input).toBeTruthy();
  expect(input.checked).toBe(false);
  expect(openBrowserRequestField()).toEqual({});
  const label = host.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)!;
  expect(label.textContent).toContain("Don't open a browser on the proxy machine");
  expect(win.document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toContain("different browser profile");
  act(() => { label.click(); });
  expect(input.checked).toBe(true);
  expect(openBrowserRequestField()).toEqual({ openBrowser: false });
  act(() => { input.click(); });
  expect(input.checked).toBe(false);
  expect(openBrowserRequestField()).toEqual({ openBrowser: true });
});
