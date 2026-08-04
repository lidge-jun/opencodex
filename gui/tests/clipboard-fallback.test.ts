import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { copyTextToClipboard } from "../src/oauth-health-display";

/**
 * `navigator.clipboard` only exists in a secure context. A LAN-bound GUI
 * (`hostname: 0.0.0.0` over plain HTTP) is not one, so the legacy execCommand
 * path is that deployment's only way to copy a login URL or a doctor command.
 */

const globals = ["document", "window", "navigator"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;

function useClipboard(value: unknown) {
  Object.defineProperty(win.navigator, "clipboard", { configurable: true, value });
}

function useExecCommand(value: unknown) {
  Object.defineProperty(win.document, "execCommand", { configurable: true, value });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://192.168.0.10:10100/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
  });
});

afterEach(async () => {
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
});

test("falls back to execCommand when the Clipboard API is absent", async () => {
  useClipboard(undefined);
  const execCommand = mock(() => true);
  useExecCommand(execCommand);

  expect(await copyTextToClipboard("https://auth.example/authorize")).toBe(true);
  expect(execCommand).toHaveBeenCalledWith("copy");
});

test("falls back when writeText rejects, as in a denied permission prompt", async () => {
  useClipboard({ writeText: async () => { throw new Error("denied"); } });
  const execCommand = mock(() => true);
  useExecCommand(execCommand);

  expect(await copyTextToClipboard("https://auth.example/authorize")).toBe(true);
  expect(execCommand).toHaveBeenCalledWith("copy");
});

test("leaves no scratch textarea behind", async () => {
  useClipboard(undefined);
  useExecCommand(mock(() => true));

  await copyTextToClipboard("https://auth.example/authorize");

  expect(win.document.querySelector("textarea")).toBeNull();
});

test("removes the scratch textarea even when execCommand throws", async () => {
  useClipboard(undefined);
  useExecCommand(() => { throw new Error("blocked"); });

  expect(await copyTextToClipboard("https://auth.example/authorize")).toBe(false);
  expect(win.document.querySelector("textarea")).toBeNull();
});

test("reports failure only when both paths are unavailable", async () => {
  useClipboard(undefined);
  useExecCommand(undefined);

  expect(await copyTextToClipboard("https://auth.example/authorize")).toBe(false);
});

test("prefers the Clipboard API and never touches the legacy path", async () => {
  const writeText = mock(async () => {});
  useClipboard({ writeText });
  const execCommand = mock(() => true);
  useExecCommand(execCommand);

  expect(await copyTextToClipboard("https://auth.example/authorize")).toBe(true);
  expect(writeText).toHaveBeenCalledWith("https://auth.example/authorize");
  expect(execCommand).not.toHaveBeenCalled();
});
