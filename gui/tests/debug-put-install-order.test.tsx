import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Debug from "../src/pages/Debug";
import type { DebugSettings } from "../src/pages/debug-shared";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
/** Survives afterEach restore so a late React 19 dispatchSetState can read window.event. */
const WINDOW_EVENT_STUB: { event: undefined } = { event: undefined };
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const BASE_SETTINGS: DebugSettings = {
  enabled: false,
  usage: false,
  injection: false,
  claude: false,
  runtimeOverride: {},
  env: { debug: false, usage: false, injection: false, claude: false },
};

function installLayoutStubs(win: Window): void {
  const proto = win.HTMLElement.prototype as unknown as HTMLElement;
  Object.defineProperty(proto, "clientHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "clientWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get() { return 1200; } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get() { return 800; } });
  Object.defineProperty(proto, "getBoundingClientRect", {
    configurable: true,
    value() {
      return {
        x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
        toJSON() { return this; },
      };
    },
  });

  class ResizeObserverStub {
    #cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.#cb = cb; }
    observe(target: Element) {
      this.#cb(
        [{
          target,
          contentRect: {
            x: 0, y: 0, top: 0, left: 0, bottom: 800, right: 1200, width: 1200, height: 800,
            toJSON() { return this; },
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
  Object.defineProperty(win, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}

beforeEach(() => {
  // Prior Debug tests share `debug-settings:http://localhost`; a warm module cache skips
  // the cold-start GET and leaves pollCount at 0 (seen on Windows CI after mutation-busy).
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#debug" });
  // React 19 resolveUpdatePriority reads window.event; happy-dom omits the IE legacy field.
  Object.defineProperty(testWindow, "event", { configurable: true, writable: true, value: undefined });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  // Drain deferred React 19 work before restoring globals (same pattern as rail-hover).
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      await Promise.resolve();
    }
  });
  testWindow.close();
  clearClientResourceStoresForTests();
  for (const key of globals) {
    let value = previousGlobals[key];
    if (key === "window") {
      if (value == null || typeof value !== "object") {
        value = WINDOW_EVENT_STUB;
      } else if (!Object.prototype.hasOwnProperty.call(value, "event")) {
        try {
          Object.defineProperty(value, "event", {
            configurable: true,
            writable: true,
            value: undefined,
          });
        } catch {
          value = WINDOW_EVENT_STUB;
        }
      }
    }
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
    });
  }
}

test("the PUT response is installed before controls re-enable", async () => {
  // Both existing tests end at the same state they started from (usage=false), so dropping
  // setClientResourceData() would still satisfy their final assertions. This one drives a
  // false -> true transition: the switch must already read the PUT response at the moment it
  // becomes interactive again, not fall back to the retained/polled initial settings.
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  let resolvePut!: () => void;
  let pollCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/debug/logs") || url.includes("/api/debug/usage-logs") || url.includes("/api/debug/injection-logs")) {
      return Response.json([]);
    }
    if (url.endsWith("/api/debug") && method === "GET") {
      // The poll ALWAYS answers with the pre-mutation state, before and after the PUT. So the
      // only way the switch can read `true` is the PUT response being installed into the store.
      // If setClientResourceData() were dropped, the next poll would overwrite it with false.
      pollCount++;
      return Response.json(BASE_SETTINGS);
    }
    if (url.endsWith("/api/debug") && method === "PUT") {
      await new Promise<void>(resolve => { resolvePut = resolve; });
      return Response.json({
        ...BASE_SETTINGS,
        usage: true,
        runtimeOverride: { usage: true },
      } satisfies DebugSettings);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <Debug apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await waitFor(() => container.querySelector('button.switch[aria-label="Usage extraction"]') != null);

  const usageSwitch = () => container.querySelector<HTMLButtonElement>('button.switch[aria-label="Usage extraction"]');
  expect(usageSwitch()?.getAttribute("aria-pressed")).toBe("false");

  await act(async () => { usageSwitch()?.click(); });
  await waitFor(() => usageSwitch()?.disabled === true);

  await act(async () => {
    resolvePut();
    await Promise.resolve();
  });
  await waitFor(() => usageSwitch()?.disabled === false);

  // Decisive: enabled again AND already showing the mutated value, even though every GET
  // still returns usage=false.
  expect(usageSwitch()?.getAttribute("aria-pressed")).toBe("true");
  expect(pollCount).toBeGreaterThan(0);

  await act(async () => { root.unmount(); });
  container.remove();
});
