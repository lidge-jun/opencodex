import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { logsTabKeyDown, readTabFromHash, selectLogsTab } from "../src/pages/logs-tab-keydown";

const globals = ["document", "window", "navigator"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#logs" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function keyEvent(key: string): ReactKeyboardEvent & { prevented: boolean } {
  let prevented = false;
  const e = {
    key,
    preventDefault() { prevented = true; },
    get prevented() { return prevented; },
  };
  return e as unknown as ReactKeyboardEvent & { prevented: boolean };
}

function mountTabs() {
  const logs = testWindow.document.createElement("button");
  logs.id = "logs-tab-logs";
  const debug = testWindow.document.createElement("button");
  debug.id = "logs-tab-debug";
  testWindow.document.body.append(logs, debug);
  return { logs, debug };
}

test("readTabFromHash maps logs and logs/debug hashes", () => {
  testWindow.location.hash = "#logs";
  expect(readTabFromHash()).toBe("logs");

  testWindow.location.hash = "#logs/debug";
  expect(readTabFromHash()).toBe("debug");

  testWindow.location.hash = "#/logs/debug";
  expect(readTabFromHash()).toBe("debug");

  testWindow.location.hash = "#logs/other";
  expect(readTabFromHash()).toBe("logs");
});

test("selectLogsTab writes the matching hash", () => {
  selectLogsTab("debug");
  expect(testWindow.location.hash).toBe("#logs/debug");

  selectLogsTab("logs");
  expect(testWindow.location.hash).toBe("#logs");
});

test("ArrowLeft and Home select logs and focus the logs tab", () => {
  const { logs, debug } = mountTabs();
  debug.focus();

  for (const key of ["ArrowLeft", "Home"] as const) {
    testWindow.location.hash = "#logs/debug";
    debug.focus();
    const e = keyEvent(key);
    logsTabKeyDown(e);
    expect(e.prevented).toBe(true);
    expect(testWindow.location.hash).toBe("#logs");
    expect(testWindow.document.activeElement).toBe(logs);
  }
});

test("ArrowRight and End select debug and focus the debug tab", () => {
  const { logs, debug } = mountTabs();
  logs.focus();

  for (const key of ["ArrowRight", "End"] as const) {
    testWindow.location.hash = "#logs";
    logs.focus();
    const e = keyEvent(key);
    logsTabKeyDown(e);
    expect(e.prevented).toBe(true);
    expect(testWindow.location.hash).toBe("#logs/debug");
    expect(testWindow.document.activeElement).toBe(debug);
  }
});

test("unrelated keys do not navigate or preventDefault", () => {
  mountTabs();
  testWindow.location.hash = "#logs";
  const e = keyEvent("ArrowDown");
  logsTabKeyDown(e);
  expect(e.prevented).toBe(false);
  expect(testWindow.location.hash).toBe("#logs");
});
