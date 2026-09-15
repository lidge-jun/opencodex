import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import FastRowsSetting from "../src/components/FastRowsSetting";
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

describe("FastRowsSetting", () => {
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

  async function mount(fetchMock: typeof fetch, onSaved?: () => void): Promise<HTMLElement> {
    globalThis.fetch = fetchMock;
    const host = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(host as never);
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      mountedRoot = createRoot(host);
      mountedRoot.render(
        <LanguageProvider>
          <FastRowsSetting apiBase="http://proxy" onSaved={onSaved} />
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

  test("loads fastRows: true by default and renders description", async () => {
    const settings = deferred<Response>();
    const host = await mount((async () => settings.promise) as typeof fetch);

    expect(host.textContent).toContain("Show Fast model rows");
    expect(host.querySelector("button.toggle")).toBeNull();

    await act(async () => {
      settings.resolve(response({ fastRows: true }));
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("Adds eligible “Model Fast” selectors to external client model pickers");
  });

  test("reflects false state when fastRows is disabled", async () => {
    const host = await mount((async () => response({ fastRows: false })) as typeof fetch);

    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
  });

  test("serializes rapid clicks, sends PUT, and triggers onSaved callback", async () => {
    const pendingPut = deferred<Response>();
    let puts = 0;
    let savedCalled = false;
    const host = await mount(
      (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          puts += 1;
          return pendingPut.promise;
        }
        return response({ fastRows: true });
      }) as typeof fetch,
      () => { savedCalled = true; },
    );

    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");

    act(() => {
      toggle(host).click();
      toggle(host).click();
    });
    expect(puts).toBe(1);
    expect(toggle(host).disabled).toBe(true);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      pendingPut.resolve(response({
        ok: true,
        fastRows: false,
        catalogRefreshPending: false,
      }));
      await flush();
    });
    expect(toggle(host).disabled).toBe(false);
    expect(toggle(host).getAttribute("aria-pressed")).toBe("false");
    expect(savedCalled).toBe(true);
    expect(host.textContent).toContain("Fast model rows disabled.");
  });

  test("renders catalog refresh pending as an amber warning", async () => {
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return response({
          ok: true,
          fastRows: false,
          catalogRefreshPending: true,
        });
      }
      return response({ fastRows: true });
    }) as typeof fetch);

    await act(async () => {
      toggle(host).click();
      await flush();
    });
    const warning = host.querySelector<HTMLElement>(".fast-rows-feedback.is-warn");
    expect(warning?.textContent).toContain("Catalog refresh is pending");
    expect(warning?.getAttribute("role")).toBe("status");
  });

  test("failed saves revert the optimistic toggle and show error feedback", async () => {
    const host = await mount((async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return response({ error: "server error" }, 500);
      return response({ fastRows: true });
    }) as typeof fetch);

    await act(async () => {
      toggle(host).click();
      await flush();
    });
    expect(toggle(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Failed to update");
  });

  test("contains an initial load failure and recovers on retry", async () => {
    let shouldFail = true;
    const host = await mount((async () => {
      if (shouldFail) return response({ error: "server error" }, 500);
      return response({ fastRows: true });
    }) as typeof fetch);

    expect(host.querySelector("button.toggle")).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Could not load Fast rows setting");

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
});
