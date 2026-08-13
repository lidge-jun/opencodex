import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPickerSetting from "../src/components/CodexAccountPickerSetting";
import { LanguageProvider } from "../src/i18n/provider";

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoot: Root | null;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CodexAccountPickerSetting", () => {
  beforeEach(() => {
    previousDomGlobals = Object.fromEntries(
      domGlobals.map(key => [key, Reflect.get(globalThis, key)]),
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
  });

  afterEach(async () => {
    if (mountedRoot) {
      await act(async () => { mountedRoot?.unmount(); });
      mountedRoot = null;
    }
    for (const key of domGlobals) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
    }
    await testWindow.happyDOM?.close?.();
  });

  async function mount(fetchMock: typeof fetch): Promise<HTMLElement> {
    globalThis.fetch = fetchMock;
    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(
        <LanguageProvider>
          <CodexAccountPickerSetting apiBase="http://proxy" />
        </LanguageProvider>,
      );
    });
    await act(async () => { await flush(); });
    return host;
  }

  function toggle(host: ParentNode): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>("button.toggle");
    if (!button) throw new Error("toggle missing");
    return button;
  }

  test("explains exact account targeting generically and waits for effective state", async () => {
    const settings = deferred<Response>();
    const host = await mount((async () => settings.promise) as typeof fetch);

    expect(host.textContent).toContain("Target a specific Codex account from the model picker");
    expect(host.querySelector("button.toggle")).toBeNull();
    expect(host.textContent).not.toMatch(/Personal|Work/);

    await act(async () => {
      settings.resolve(response({ codexAccountPickerEnabled: true }));
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("never rotates or falls back");
    expect(host.textContent).toContain("stable privacy-safe labels");
    expect(host.textContent).toContain("Existing conversations and saved model selections continue routing");
    expect(host.textContent).toContain("Plain GPT model IDs keep their Pool or Direct behavior");
  });

  test("serializes rapid clicks and trusts the confirmed response state", async () => {
    const pendingPut = deferred<Response>();
    let puts = 0;
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        return pendingPut.promise;
      }
      return response({ codexAccountPickerEnabled: false });
    }) as typeof fetch);

    act(() => {
      toggle(host).click();
      toggle(host).click();
    });
    expect(puts).toBe(1);
    expect(toggle(host).disabled).toBe(true);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      pendingPut.resolve(response({
        ok: true,
        codexAccountPickerEnabled: false,
        catalogRefreshPending: false,
      }));
      await flush();
    });
    expect(toggle(host).disabled).toBe(false);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
  });

  test("renders a saved pending refresh as an amber warning", async () => {
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return response({
          ok: true,
          codexAccountPickerEnabled: true,
          catalogRefreshPending: true,
          privateDetail: "private-account-detail",
        });
      }
      return response({ codexAccountPickerEnabled: false });
    }) as typeof fetch);

    await act(async () => {
      toggle(host).click();
      await flush();
    });
    const warning = host.querySelector<HTMLElement>(".codex-account-picker-feedback.is-warn");
    expect(warning?.textContent).toContain("ocx sync");
    expect(warning?.getAttribute("role")).toBe("status");
    expect(host.textContent).not.toContain("private-account-detail");
  });

  test("failed saves revert the optimistic toggle and show only generic feedback", async () => {
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return response({ error: "private server path" }, 500);
      return response({ codexAccountPickerEnabled: false });
    }) as typeof fetch);

    await act(async () => {
      toggle(host).click();
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("last confirmed setting");
    expect(host.textContent).not.toContain("private server path");
  });

  test("contains an initial load failure without exposing an actionable false state", async () => {
    let shouldFail = true;
    const host = await mount((async () => {
      if (shouldFail) return response({ error: "private server path" }, 500);
      return response({ codexAccountPickerEnabled: true });
    }) as typeof fetch);

    expect(host.querySelector("button.toggle")).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Could not load");
    expect(host.textContent).not.toContain("private server path");

    shouldFail = false;
    const retry = Array.from(host.querySelectorAll("button")).find(button =>
      button.textContent === "Retry"
    );
    expect(retry).toBeTruthy();
    await act(async () => {
      retry?.click();
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
  });

  test("keeps the last confirmed toggle actionable after a background refresh failure", async () => {
    let getCount = 0;
    let putCount = 0;
    let pollCallback: (() => void) | null = null;
    const originalSetInterval = testWindow.setInterval.bind(testWindow);
    testWindow.setInterval = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (typeof callback === "function") pollCallback = callback as () => void;
      return originalSetInterval(callback, ms, ...args) as number;
    }) as typeof testWindow.setInterval;
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        putCount += 1;
        return response({
          ok: true,
          codexAccountPickerEnabled: false,
          catalogRefreshPending: false,
        });
      }
      getCount += 1;
      return getCount === 1
        ? response({ codexAccountPickerEnabled: true })
        : response({ error: "temporary" }, 503);
    }) as typeof fetch);

    await act(async () => {
      pollCallback?.();
      await flush();
    });

    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(toggle(host).disabled).toBe(false);
    expect(host.textContent).toContain("Could not refresh this setting");
    expect(Array.from(host.querySelectorAll("button")).some(button => button.textContent === "Retry")).toBe(true);

    await act(async () => {
      toggle(host).click();
      await flush();
    });

    expect(putCount).toBe(1);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).not.toContain("Could not refresh this setting");
  });

  test("an older poll cannot overwrite an optimistic or confirmed mutation", async () => {
    const stalePoll = deferred<Response>();
    const pendingPut = deferred<Response>();
    let getCount = 0;
    let pollCallback: (() => void) | null = null;
    const originalSetInterval = testWindow.setInterval.bind(testWindow);
    testWindow.setInterval = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (typeof callback === "function") pollCallback = callback as () => void;
      return originalSetInterval(callback, ms, ...args) as number;
    }) as typeof testWindow.setInterval;
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return pendingPut.promise;
      getCount += 1;
      return getCount === 1
        ? response({ codexAccountPickerEnabled: false })
        : stalePoll.promise;
    }) as typeof fetch);

    await act(async () => {
      pollCallback?.();
      await flush();
      toggle(host).click();
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      stalePoll.resolve(response({ codexAccountPickerEnabled: false }));
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      pendingPut.resolve(response({
        ok: true,
        codexAccountPickerEnabled: true,
        catalogRefreshPending: false,
      }));
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
  });
});
