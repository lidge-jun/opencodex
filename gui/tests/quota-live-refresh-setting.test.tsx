import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import QuotaLiveRefreshSetting from "../src/components/QuotaLiveRefreshSetting";
import { LanguageProvider } from "../src/i18n/provider";
import { readQuotaLiveRefreshPref } from "../src/quota-live-refresh-pref";

const KEY = "ocx.quota.liveRefresh";
const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null;

beforeEach(async () => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  // Loaded after the DOM globals exist: react-dom decides at import time whether it can use the
  // DOM, and without that its keyboard handlers never see a dispatched keydown.
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host as unknown as HTMLElement);
    root.render(<LanguageProvider><QuotaLiveRefreshSetting /></LanguageProvider>);
  });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  win.close();
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const toggle = () => win.document.querySelector("button.toggle") as unknown as HTMLButtonElement;
const input = () => win.document.querySelector("input[type=number]") as unknown as HTMLInputElement;
const stored = () => JSON.parse(win.localStorage.getItem(KEY) ?? "null") as unknown;

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

async function press(key: string) {
  await act(async () => { input().dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true })); });
}

test("the row names itself, explains it adds no provider queries, and shows the defaults", () => {
  const text = win.document.body.textContent ?? "";
  expect(text).toContain("Live quota updates");
  expect(text).toContain("providers are not queried more often");
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  expect(toggle().getAttribute("aria-label")).toBe("Live quota updates");
  expect(input().value).toBe("15");
  expect(input().getAttribute("aria-label")).toBe("Live quota update interval in seconds (5–600)");
  expect(input().getAttribute("min")).toBe("5");
  expect(input().getAttribute("max")).toBe("600");
});

test("the toggle saves the choice in this browser", async () => {
  await act(async () => { toggle().click(); });
  expect(stored()).toEqual({ enabled: false, intervalSeconds: 15 });
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(input().disabled).toBe(true);
  await act(async () => { toggle().click(); });
  expect(stored()).toEqual({ enabled: true, intervalSeconds: 15 });
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
});

test("Enter saves a valid interval", async () => {
  await type("30");
  expect(stored()).toBeNull();
  await press("Enter");
  expect(stored()).toEqual({ enabled: true, intervalSeconds: 30 });
  expect(input().value).toBe("30");
});

test("an interval outside the range is clamped, and the field shows what took effect", async () => {
  await type("2");
  await act(async () => { input().dispatchEvent(new win.FocusEvent("focusout", { bubbles: true })); });
  expect(stored()).toEqual({ enabled: true, intervalSeconds: 5 });
  expect(input().value).toBe("5");
  await type("100000");
  await press("Enter");
  expect(stored()).toEqual({ enabled: true, intervalSeconds: 600 });
  expect(input().value).toBe("600");
  await type("12.4");
  await press("Enter");
  expect(readQuotaLiveRefreshPref().intervalSeconds).toBe(12);
  expect(input().value).toBe("12");
});

test("empty or non-numeric input keeps the saved interval, and Escape discards a draft", async () => {
  await type("45");
  await press("Enter");
  await type("");
  await press("Enter");
  expect(stored()).toEqual({ enabled: true, intervalSeconds: 45 });
  expect(input().value).toBe("45");
  await type("abc");
  await act(async () => { input().dispatchEvent(new win.FocusEvent("focusout", { bubbles: true })); });
  expect(stored()).toEqual({ enabled: true, intervalSeconds: 45 });
  expect(input().value).toBe("45");
  await type("90");
  await press("Escape");
  expect(input().value).toBe("45");
  expect(stored()).toEqual({ enabled: true, intervalSeconds: 45 });
});

test("the steppers save at once in whole steps inside the range", async () => {
  const [up, down] = [...win.document.querySelectorAll(".ocx-stepper__btn")] as unknown as HTMLButtonElement[];
  await act(async () => { up.click(); });
  expect(stored()).toEqual({ enabled: true, intervalSeconds: 20 });
  expect(input().value).toBe("20");
  for (let index = 0; index < 5; index += 1) await act(async () => { down.click(); });
  expect(stored()).toEqual({ enabled: true, intervalSeconds: 5 });
  expect(input().value).toBe("5");
});

test("a change made in another tab shows up in the row", async () => {
  win.localStorage.setItem(KEY, JSON.stringify({ enabled: false, intervalSeconds: 120 }));
  await act(async () => { win.dispatchEvent(new win.StorageEvent("storage", { key: KEY })); });
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(input().value).toBe("120");
});
