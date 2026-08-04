import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import Debug from "../src/pages/Debug";
import type { DebugSettings } from "../src/pages/debug-shared";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"] as const;
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
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#debug" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installLayoutStubs(testWindow);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
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

test("rapid Debug flag/reset keeps controls busy and applies only the latest mutation", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  type Gate = { resolve: () => void };
  const putGates: Gate[] = [];
  const putBodies: unknown[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/debug/logs") || url.includes("/api/debug/usage-logs") || url.includes("/api/debug/injection-logs")) {
      return Response.json([]);
    }
    if (url.endsWith("/api/debug") && method === "GET") {
      return Response.json(BASE_SETTINGS);
    }
    if (url.endsWith("/api/debug") && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      putBodies.push(body);
      await new Promise<void>(resolve => {
        putGates.push({ resolve });
      });
      if (body.reset === true) {
        return Response.json({
          ...BASE_SETTINGS,
          enabled: false,
          usage: false,
          injection: false,
          claude: false,
          runtimeOverride: {},
        } satisfies DebugSettings);
      }
      return Response.json({
        ...BASE_SETTINGS,
        enabled: body.debug === true ? true : BASE_SETTINGS.enabled,
        usage: body.usage === true ? true : BASE_SETTINGS.usage,
        injection: body.injection === true ? true : BASE_SETTINGS.injection,
        claude: body.claude === true ? true : BASE_SETTINGS.claude,
        runtimeOverride: {
          ...(body.debug === true ? { debug: true } : {}),
          ...(body.usage === true ? { usage: true } : {}),
          ...(body.injection === true ? { injection: true } : {}),
          ...(body.claude === true ? { claude: true } : {}),
        },
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
  const resetBtn = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(btn =>
    (btn.textContent ?? "").includes("Clear runtime overrides"),
  );

  // Fire flag + reset before the first busy paint can serialize them via disabled controls.
  await act(async () => {
    usageSwitch()?.click();
    resetBtn()?.click();
  });
  // Serialized: only the first PUT is in flight until it settles.
  await waitFor(() => putGates.length === 1);
  expect(putBodies).toEqual([{ usage: true }]);
  expect(usageSwitch()?.disabled).toBe(true);
  expect(resetBtn()?.disabled).toBe(true);

  await act(async () => {
    putGates[0]!.resolve();
    await Promise.resolve();
  });
  await waitFor(() => putGates.length === 2);
  expect(putBodies[1]).toEqual({ reset: true });
  expect(usageSwitch()?.disabled).toBe(true);

  await act(async () => {
    putGates[1]!.resolve();
    await Promise.resolve();
  });
  await waitFor(() => usageSwitch()?.disabled === false);
  expect(usageSwitch()?.getAttribute("aria-pressed")).toBe("false");
  expect(resetBtn()?.disabled).toBe(false);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});

test("Debug PUTs are serialized so reverse-order response settlement cannot leave server ahead of UI", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  type Gate = { resolve: () => void };
  const putGates: Gate[] = [];
  const putStartOrder: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let serverSettings: DebugSettings = { ...BASE_SETTINGS, runtimeOverride: {}, env: { ...BASE_SETTINGS.env } };
  const serverSnapshots: DebugSettings[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/debug/logs") || url.includes("/api/debug/usage-logs") || url.includes("/api/debug/injection-logs")) {
      return Response.json([]);
    }
    if (url.endsWith("/api/debug") && method === "GET") {
      return Response.json(serverSettings);
    }
    if (url.endsWith("/api/debug") && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      putStartOrder.push(body.reset === true ? "reset" : Object.keys(body).sort().join(","));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise<void>(resolve => {
          putGates.push({ resolve });
        });
        // Apply when the response settles. Concurrent PUTs + reverse resolve
        // order (reset, then usage) would leave usage=true on the server while
        // browser generation checks show the reset UI — serialization prevents that.
        if (body.reset === true) {
          serverSettings = {
            ...BASE_SETTINGS,
            enabled: false,
            usage: false,
            injection: false,
            claude: false,
            runtimeOverride: {},
            env: { ...BASE_SETTINGS.env },
          };
        } else {
          serverSettings = {
            ...serverSettings,
            enabled: body.debug === undefined ? serverSettings.enabled : body.debug === true,
            usage: body.usage === undefined ? serverSettings.usage : body.usage === true,
            injection: body.injection === undefined ? serverSettings.injection : body.injection === true,
            claude: body.claude === undefined ? serverSettings.claude : body.claude === true,
            runtimeOverride: {
              ...serverSettings.runtimeOverride,
              ...(body.debug === undefined ? {} : { debug: body.debug === true }),
              ...(body.usage === undefined ? {} : { usage: body.usage === true }),
              ...(body.injection === undefined ? {} : { injection: body.injection === true }),
              ...(body.claude === undefined ? {} : { claude: body.claude === true }),
            },
          };
        }
        serverSnapshots.push({
          ...serverSettings,
          runtimeOverride: { ...serverSettings.runtimeOverride },
          env: { ...serverSettings.env },
        });
        return Response.json(serverSettings);
      } finally {
        inFlight -= 1;
      }
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
  const resetBtn = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(btn =>
    (btn.textContent ?? "").includes("Clear runtime overrides"),
  );

  await act(async () => {
    usageSwitch()?.click();
    resetBtn()?.click();
  });

  await waitFor(() => putGates.length === 1);
  expect(putStartOrder).toEqual(["usage"]);
  // Attempt reverse-order settlement: only the in-flight PUT can resolve.
  // A concurrent implementation would have putGates[1] available here.
  expect(putGates[1]).toBeUndefined();
  await act(async () => {
    putGates[0]!.resolve();
    await Promise.resolve();
  });
  await waitFor(() => putGates.length === 2);
  expect(putStartOrder).toEqual(["usage", "reset"]);
  expect(serverSnapshots[0]?.usage).toBe(true);

  await act(async () => {
    putGates[1]!.resolve();
    await Promise.resolve();
  });
  await waitFor(() => usageSwitch()?.disabled === false);

  expect(maxInFlight).toBe(1);
  expect(serverSettings.usage).toBe(false);
  expect(serverSettings.runtimeOverride).toEqual({});
  expect(usageSwitch()?.getAttribute("aria-pressed")).toBe("false");
  expect(serverSnapshots.at(-1)?.usage).toBe(false);

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
