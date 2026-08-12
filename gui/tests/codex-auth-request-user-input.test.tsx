import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import DefaultModeRequestUserInputSetting from "../src/components/DefaultModeRequestUserInputSetting";
import { LanguageProvider } from "../src/i18n/provider";

let previousLanguage: unknown;

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoot: Root | null;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

function setupDom(): void {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountedRoot = null;
}

async function teardownDom(): Promise<void> {
  if (mountedRoot) {
    await act(async () => {
      mountedRoot?.unmount();
    });
    mountedRoot = null;
  }
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
}

describe("DefaultModeRequestUserInputSetting", () => {
  beforeEach(() => setupDom());
  afterEach(async () => {
    await teardownDom();
  });

  async function mount(fetchMock: typeof fetch): Promise<ParentNode> {
    globalThis.fetch = fetchMock;
    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(
        <LanguageProvider>
          <DefaultModeRequestUserInputSetting apiBase="http://proxy" />
        </LanguageProvider>,
      );
    });
    await act(async () => { await flush(); });
    return host;
  }

  function toggleButton(host: ParentNode): HTMLButtonElement {
    const el = host.querySelector<HTMLButtonElement>("button.toggle");
    if (!el) throw new Error("toggle missing");
    return el;
  }

  test("renders the flag card and stays disabled until the GET hydrates", async () => {
    const active = deferred<Response>();
    const host = await mount((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/codex-auth/features/default-mode-request-user-input") && (!init || init.method === undefined)) {
        return active.promise;
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    }) as typeof fetch);

    expect(host.textContent).toContain("Ask for input in Default mode");
    expect(host.textContent).toContain("[features]\ndefault_mode_request_user_input = true");
    expect(toggleButton(host).disabled).toBe(true);

    await act(async () => {
      active.resolve(new Response(JSON.stringify({ enabled: true, key: "default_mode_request_user_input" }), { status: 200 }));
      await flush();
    });
    expect(toggleButton(host).disabled).toBe(false);
    expect(toggleButton(host).getAttribute("aria-pressed")).toBe("true");
  });

  test("toggle PUTs the new value and shows confirmation", async () => {
    const puts: unknown[] = [];
    const host = await mount((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/codex-auth/features/default-mode-request-user-input") && init?.method === "PUT") {
        puts.push(init.body ? JSON.parse(String(init.body)) : null);
        return new Response(JSON.stringify({ ok: true, enabled: true, changed: true, warnings: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ enabled: false, key: "default_mode_request_user_input" }), { status: 200 });
    }) as typeof fetch);

    await act(async () => {
      toggleButton(host).click();
      await flush();
    });
    expect(puts).toEqual([{ enabled: true }]);
    expect(toggleButton(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("Restart the Codex app to pick it up.");
  });

  test("an unchanged PUT keeps the base success copy without the restart hint", async () => {
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ ok: true, enabled: true, changed: false, warnings: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ enabled: false, key: "default_mode_request_user_input" }), { status: 200 });
    }) as typeof fetch);

    await act(async () => {
      toggleButton(host).click();
      await flush();
    });
    expect(host.textContent).toContain("Feature flag updated - applies to new sessions.");
    expect(host.textContent).not.toContain("Restart the Codex app");
  });

  test("failed PUT reverts the toggle and reports the error", async () => {
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(JSON.stringify({ error: "toggle failed" }), { status: 502 });
      }
      return new Response(JSON.stringify({ enabled: false, key: "default_mode_request_user_input" }), { status: 200 });
    }) as typeof fetch);

    await act(async () => {
      toggleButton(host).click();
      await flush();
    });
    expect(toggleButton(host).getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).toContain("toggle failed");
  });

  test("a poll GET in flight during a toggle cannot revert the optimistic state", async () => {
    const firstGet = deferred<Response>();
    const secondGet = deferred<Response>();
    const put = deferred<Response>();
    let getCount = 0;
    let putStarted = false;
    let pollCallback: (() => void) | null = null;
    const originalSetInterval = testWindow.setInterval.bind(testWindow);
    testWindow.setInterval = ((_cb: TimerHandler, _ms?: number, ..._args: unknown[]) => {
      // Hold the 30s poll so the test can fire it at the exact overlap point.
      if (typeof _cb === "function") pollCallback = _cb as () => void;
      return originalSetInterval(_cb, _ms, ..._args) as number;
    }) as typeof testWindow.setInterval;

    const host = await mount((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/codex-auth/features/default-mode-request-user-input") && init?.method === "PUT") {
        putStarted = true;
        return put.promise;
      }
      if (url.endsWith("/api/codex-auth/features/default-mode-request-user-input")) {
        getCount++;
        return getCount === 1 ? firstGet.promise : secondGet.promise;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch);

    await act(async () => {
      firstGet.resolve(new Response(JSON.stringify({ enabled: false, key: "default_mode_request_user_input" }), { status: 200 }));
      await flush();
    });
    expect(toggleButton(host).disabled).toBe(false);
    expect(toggleButton(host).getAttribute("aria-pressed")).toBe("false");

    // Start the poll GET that will still be in flight when the user toggles.
    await act(async () => {
      pollCallback?.();
      await flush();
    });

    await act(async () => {
      toggleButton(host).click();
      await flush();
    });
    expect(toggleButton(host).getAttribute("aria-pressed")).toBe("true");

    // The stale pre-toggle GET resolves mid-PUT and must be ignored.
    await act(async () => {
      secondGet.resolve(new Response(JSON.stringify({ enabled: false, key: "default_mode_request_user_input" }), { status: 200 }));
      await flush();
    });
    expect(toggleButton(host).getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      put.resolve(new Response(JSON.stringify({ ok: true, enabled: true, changed: true, warnings: [] }), { status: 200 }));
      await flush();
    });
    expect(toggleButton(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("Restart the Codex app to pick it up.");
  });
});
