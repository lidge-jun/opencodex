import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { CodexStaleBanner } from "../src/components/codex-stale-banner";
import { useCodexRestart } from "../src/use-codex-restart";
import type { CodexRestartResponse } from "../src/codex-restart";

/**
 * Real DOM behavior for the staleness surface.
 *
 * The predecessor of this file asserted implementation strings, and it passed
 * while a restart from the page-head button left the banner on screen — the
 * refresh only ran from the banner's own click handler. Source-text assertions
 * cannot see that, so these render the components and drive them.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let originalConfirm: typeof globalThis.confirm;
let originalAlert: typeof globalThis.alert;

function restartBody(overrides: Partial<CodexRestartResponse> = {}): CodexRestartResponse {
  return {
    success: true,
    stateBefore: "stale",
    synced: true,
    requested: [4242],
    stopped: [4242],
    surviving: [],
    failed: [],
    code: "stopped",
    ...overrides,
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  originalConfirm = globalThis.confirm;
  originalAlert = globalThis.alert;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(globalThis, "confirm", { configurable: true, value: () => true });
  Object.defineProperty(globalThis, "alert", { configurable: true, value: () => {} });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  Object.defineProperty(globalThis, "confirm", { configurable: true, value: originalConfirm });
  Object.defineProperty(globalThis, "alert", { configurable: true, value: originalAlert });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
});

/** Mirrors how Models.tsx wires the controller, banner, and head action. */
function Harness(props: {
  initialState: "fresh" | "stale" | "not_running" | "unknown" | null;
  onReload: () => void;
}) {
  const controller = useCodexRestart("", { onSettled: () => props.onReload() });
  return (
    <div>
      <button type="button" data-testid="head" onClick={() => { void controller.restart(); }}
        disabled={controller.restarting} aria-label="head restart">
        head
      </button>
      <CodexStaleBanner state={props.initialState} controller={controller} />
    </div>
  );
}

function render(node: React.ReactNode) {
  root = createRoot(host);
  act(() => root!.render(<LanguageProvider>{node}</LanguageProvider>));
}

test("the banner renders only for stale", () => {
  for (const state of ["fresh", "not_running", "unknown", null] as const) {
    render(<Harness initialState={state} onReload={() => {}} />);
    expect(host.querySelector(".codex-stale-banner")).toBeNull();
    act(() => root!.unmount());
    root = null;
  }

  render(<Harness initialState="stale" onReload={() => {}} />);
  expect(host.querySelector(".codex-stale-banner")).not.toBeNull();
});

test("a restart from the PAGE-HEAD button refreshes staleness", async () => {
  // The regression this file exists for: the head button called restart() and
  // nothing re-read the state, so the banner stayed on screen after a success.
  let reloads = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(JSON.stringify(restartBody()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  render(<Harness initialState="stale" onReload={() => { reloads += 1; }} />);
  const head = host.querySelector('[data-testid="head"]') as HTMLButtonElement;
  await act(async () => { head.click(); });

  expect(reloads).toBe(1);
});

test("a restart from the BANNER button refreshes staleness through the same path", async () => {
  let reloads = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(JSON.stringify(restartBody()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  render(<Harness initialState="stale" onReload={() => { reloads += 1; }} />);
  const button = host.querySelector(".codex-stale-banner button") as HTMLButtonElement;
  await act(async () => { button.click(); });

  expect(reloads).toBe(1);
});

test("nothing_running also counts as settled", async () => {
  // The race where the target exits on its own between classification and
  // signalling. Refreshing on "stopped" alone would leave the banner up.
  let reloads = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(JSON.stringify(restartBody({
      code: "nothing_running",
      requested: [],
      stopped: [],
    })), { status: 200, headers: { "content-type": "application/json" } }),
  });

  render(<Harness initialState="stale" onReload={() => { reloads += 1; }} />);
  const head = host.querySelector('[data-testid="head"]') as HTMLButtonElement;
  await act(async () => { head.click(); });

  expect(reloads).toBe(1);
});

test("an unresolved outcome does not clear the banner", async () => {
  // partially_stopped means a target is still holding the old catalog, so the
  // banner must stay and the state must not be re-read as if it were settled.
  let reloads = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(JSON.stringify(restartBody({
      success: false,
      code: "partially_stopped",
      stopped: [],
      surviving: [4242],
    })), { status: 200, headers: { "content-type": "application/json" } }),
  });

  render(<Harness initialState="stale" onReload={() => { reloads += 1; }} />);
  const head = host.querySelector('[data-testid="head"]') as HTMLButtonElement;
  await act(async () => { head.click(); });

  expect(reloads).toBe(0);
  expect(host.querySelector(".codex-stale-banner")).not.toBeNull();
});

test("a declined confirm sends no request and does not refresh", async () => {
  let fetches = 0;
  let reloads = 0;
  Object.defineProperty(globalThis, "confirm", { configurable: true, value: () => false });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    },
  });

  render(<Harness initialState="stale" onReload={() => { reloads += 1; }} />);
  const head = host.querySelector('[data-testid="head"]') as HTMLButtonElement;
  await act(async () => { head.click(); });

  expect(fetches).toBe(0);
  expect(reloads).toBe(0);
});

test("both controls disable while one restart is pending", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      await gate;
      return new Response(JSON.stringify(restartBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  render(<Harness initialState="stale" onReload={() => {}} />);
  const head = host.querySelector('[data-testid="head"]') as HTMLButtonElement;
  const bannerButton = host.querySelector(".codex-stale-banner button") as HTMLButtonElement;

  await act(async () => { head.click(); });
  // One controller drives both, so the banner's button is disabled too — the two
  // controls on this page can never disagree about whether a restart is running.
  expect(head.disabled).toBe(true);
  expect(bannerButton.disabled).toBe(true);

  await act(async () => { release!(); await gate; });
});

test("unmounting during a pending restart does not throw", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      await gate;
      return new Response(JSON.stringify(restartBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  render(<Harness initialState="stale" onReload={() => {}} />);
  const head = host.querySelector('[data-testid="head"]') as HTMLButtonElement;
  await act(async () => { head.click(); });

  act(() => root!.unmount());
  root = null;
  // The request outlives the page; settling it must not touch unmounted state.
  await act(async () => { release!(); await gate; });
});

test("a timeout is localized, not left as the transport's English default", async () => {
  // The hook once dropped formatTimeout when it was rewritten, which silently
  // reverted this string to the helper's hardcoded English.
  let seen = "";
  Object.defineProperty(globalThis, "alert", {
    configurable: true,
    value: (message: string) => { seen = message; },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => { throw new DOMException("timed out", "TimeoutError"); },
  });

  render(<Harness initialState="stale" onReload={() => {}} />);
  const head = host.querySelector('[data-testid="head"]') as HTMLButtonElement;
  await act(async () => { head.click(); });

  // The English catalog entry, not the transport fallback sentence.
  expect(seen).toContain("It may still be stopping app-servers");
});

test("a settled restart does not call back after unmount", async () => {
  // The callback usually starts a refresh fetch; firing it from a page the user
  // already left is work nobody reads.
  let settled = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      await gate;
      return new Response(JSON.stringify(restartBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  render(<Harness initialState="stale" onReload={() => { settled += 1; }} />);
  const head = host.querySelector('[data-testid="head"]') as HTMLButtonElement;
  await act(async () => { head.click(); });

  act(() => root!.unmount());
  root = null;
  await act(async () => { release!(); await gate; });

  expect(settled).toBe(0);
});
