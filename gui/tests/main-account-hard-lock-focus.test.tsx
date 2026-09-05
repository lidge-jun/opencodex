import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import MainAccountHardLockSetting from "../src/components/MainAccountHardLockSetting";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test.each(["outside input", "null target"])("late recovery respects focus departure to %s", async departure => {
  const previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  const testWindow = new Window({ url: "http://localhost/#codex-set" });
  let root: Root | null = null;
  let poll: (() => void) | undefined;
  let finishRead!: (value: Response) => void;
  const laterRead = new Promise<Response>(resolve => { finishRead = resolve; });
  let reads = 0;
  const known = { codexMainAccountHardLock: true, mainAccountHardLock: { enabled: true, state: "ready" } };
  const flush = async () => {
    await Promise.resolve();
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  };
  try {
    Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
    for (const key of ["document", "window", "navigator", "localStorage"] as const) {
      Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? testWindow : testWindow[key] });
    }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    const original = testWindow.setInterval.bind(testWindow);
    testWindow.setInterval = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (typeof callback === "function") poll = callback as () => void;
      return original(callback, ms, ...args);
    }) as typeof testWindow.setInterval;
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "PUT") return response({}, 500);
      reads++;
      if (reads === 1) return response(known);
      if (reads === 2) return response({}, 503);
      return laterRead;
    }) as typeof fetch;
    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(host);
      root.render(<LanguageProvider>
        <MainAccountHardLockSetting apiBase="http://focus-fixture" onSaved={async () => true} />
        <input aria-label="Different setting" />
      </LanguageProvider>);
    });
    await act(async () => { await flush(); });
    const toggle = host.querySelector<HTMLButtonElement>("button.toggle")!;
    const section = host.querySelector<HTMLElement>("#codex-main-hard-lock-setting")!;
    const outside = host.querySelector<HTMLInputElement>("input")!;
    toggle.focus();
    await act(async () => { toggle.click(); await flush(); });
    expect(reads).toBe(2);
    expect(toggle.disabled).toBe(true);
    expect(testWindow.document.activeElement).toBe(section);
    await act(async () => {
      poll?.();
      await flush();
      if (departure === "outside input") outside.focus();
      else section.dispatchEvent(new testWindow.FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    });
    expect(reads).toBe(3);
    expect(toggle.disabled).toBe(true);
    await act(async () => { finishRead(response(known)); await flush(); });
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(testWindow.document.activeElement).toBe(departure === "outside input" ? outside : toggle);
  } finally {
    await act(async () => { root?.unmount(); });
    await testWindow.happyDOM.close();
    for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
});
