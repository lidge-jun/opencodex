import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import CodexAccountPool from "../src/components/CodexAccountPool";
import { LanguageProvider } from "../src/i18n/provider";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

interface Harness {
  container: HTMLDivElement;
  outsideButton: HTMLButtonElement;
  root: Root;
  input: HTMLInputElement;
  writes: number[];
  currentInput(): HTMLInputElement | null;
  currentToggle(): HTMLButtonElement;
  enqueueActive(response: Promise<Response> | Response): void;
  enqueuePut(response: Promise<Response> | Response): void;
  refresh(): void;
}

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let mountedRoot: Root | null;

function deferred<T>(): Deferred<T> {
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

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

function keyDown(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key, bubbles: true }));
}

function pointerToggleAfterNullTargetBlur(
  input: HTMLInputElement,
  toggle: HTMLButtonElement,
): void {
  toggle.dispatchEvent(new testWindow.Event("pointerdown", { bubbles: true }));
  input.dispatchEvent(new testWindow.FocusEvent("focusout", {
    bubbles: true,
    relatedTarget: null,
  }));
  toggle.dispatchEvent(new testWindow.Event("pointerup", { bubbles: true }));
  toggle.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }));
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  mountedRoot = null;
});

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => {
      mountedRoot?.unmount();
    });
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountHarness(): Promise<Harness> {
  const activeResponses: Array<Promise<Response> | Response> = [
    Response.json({
      activeCodexAccountId: null,
      autoSwitchThreshold: 80,
      accountPoolStrategy: "quota",
      accountPoolStickyLimit: 1,
    }),
  ];
  const putResponses: Array<Promise<Response> | Response> = [];
  const writes: number[] = [];
  let refreshCallback: (() => void) | null = null;

  Object.defineProperty(testWindow, "setInterval", {
    configurable: true,
    value: (callback: () => void, delay?: number) => {
      if (delay === 30_000) refreshCallback = callback;
      return 1;
    },
  });
  Object.defineProperty(testWindow, "clearInterval", {
    configurable: true,
    value: () => {},
  });

  const defaultActivePayload = {
    activeCodexAccountId: null,
    autoSwitchThreshold: 80,
    accountPoolStrategy: "quota",
    accountPoolStickyLimit: 1,
  };
  const fetchRouter = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.endsWith("/api/codex-auth/accounts") && method === "GET") {
      return Response.json({ accounts: [] });
    }
    // Pool controller + strategy card both GET /active; prefer queued responses for
    // stale-refresh tests, otherwise return a stable default so neither consumer fails.
    if (url.endsWith("/api/codex-auth/active") && method === "GET") {
      const response = activeResponses.shift();
      if (response) return await response;
      return Response.json(defaultActivePayload);
    }
    if (url.endsWith("/api/codex-auth/pool-strategy") && (method === "PUT" || method === "PATCH")) {
      return Response.json({
        ok: true,
        accountPoolStrategy: "quota",
        accountPoolStickyLimit: 1,
      });
    }
    if (url.endsWith("/api/codex-auth/auto-switch") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { threshold: number };
      writes.push(body.threshold);
      const response = putResponses.shift();
      if (!response) throw new Error("unexpected auto-switch write");
      return await response;
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchRouter });

  const container = document.createElement("div");
  const outsideButton = document.createElement("button");
  outsideButton.textContent = "Outside";
  document.body.append(container, outsideButton);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  mountedRoot = root;
  await act(async () => {
    root.render(
      <LanguageProvider>
        <CodexAccountPool apiBase="http://localhost" />
      </LanguageProvider>,
    );
    await flush();
  });
  await act(flush);

  const advanced = container.querySelector<HTMLButtonElement>('.codex-auth-advanced__toggle');
  if (!advanced) throw new Error("advanced settings toggle was not rendered");
  await act(async () => { advanced.click(); await flush(); });

  const input = container.querySelector<HTMLInputElement>('input[aria-label="Usage threshold, percent"]');
  expect(input).not.toBeNull();
  expect(input?.value).toBe("80");
  expect(input?.readOnly).toBe(false);
  expect(refreshCallback).not.toBeNull();

  const currentInput = (): HTMLInputElement | null => (
    container.querySelector<HTMLInputElement>('input[aria-label="Usage threshold, percent"]')
  );
  const currentToggle = (): HTMLButtonElement => {
    const toggle = container.querySelector<HTMLButtonElement>("button.toggle[aria-pressed]");
    if (!toggle) throw new Error("auto-switch toggle was not rendered");
    return toggle;
  };

  return {
    container,
    outsideButton,
    root,
    input: input!,
    writes,
    currentInput,
    currentToggle,
    enqueueActive(response) {
      activeResponses.push(response);
    },
    enqueuePut(response) {
      putResponses.push(response);
    },
    refresh() {
      if (!refreshCallback) throw new Error("refresh interval was not registered");
      refreshCallback();
    },
  };
}

describe("Codex auto-switch controller interactions", () => {
  test("defers strategy-specific switching controls until the persisted strategy resolves", async () => {
    const active = deferred<Response>();
    let activeReads = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        if (url.endsWith("/api/codex-auth/accounts") && method === "GET") {
          return Response.json({ accounts: [] });
        }
        if (url.endsWith("/api/codex-auth/active") && method === "GET") {
          activeReads += 1;
          return (await active.promise).clone();
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      },
    });

    const container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    mountedRoot = createRoot(container);
    await act(async () => {
      mountedRoot?.render(
        <LanguageProvider>
          <CodexAccountPool apiBase="http://localhost" />
        </LanguageProvider>,
      );
      await flush();
    });

    expect(activeReads).toBeGreaterThan(0);
    expect(container.querySelector(".codex-auto-switch-card")).toBeNull();

    active.resolve(Response.json({
      activeCodexAccountId: null,
      autoSwitchThreshold: 80,
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 1,
    }));
    await act(flush);

    expect(container.querySelector(".codex-auto-switch-card")).toBeNull();
    const advanced = container.querySelector<HTMLButtonElement>(".codex-auth-advanced__toggle");
    expect(advanced).not.toBeNull();
    await act(async () => { advanced!.click(); await flush(); });

    const card = container.querySelector<HTMLElement>(".codex-auto-switch-card");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Round-robin");
    expect(card?.querySelector<HTMLInputElement>('input[aria-label="Usage threshold, percent"]')?.readOnly).toBe(false);
  });

  test("blocks writes while /active is still pending", async () => {
    const active = deferred<Response>();
    const activeResponses: Array<Promise<Response> | Response> = [active.promise];
    const putResponses: Array<Promise<Response> | Response> = [];
    const writes: number[] = [];
    let refreshCallback: (() => void) | null = null;

    Object.defineProperty(testWindow, "setInterval", {
      configurable: true,
      value: (callback: () => void, delay?: number) => {
        if (delay === 30_000) refreshCallback = callback;
        return 1;
      },
    });
    Object.defineProperty(testWindow, "clearInterval", {
      configurable: true,
      value: () => {},
    });

    const fetchRouter = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.endsWith("/api/codex-auth/accounts") && method === "GET") {
        return Response.json({ accounts: [] });
      }
      if (url.endsWith("/api/codex-auth/active") && method === "GET") {
        const response = activeResponses.shift();
        if (response) return await response;
        return Response.json({
          activeCodexAccountId: null,
          autoSwitchThreshold: 55,
          accountPoolStrategy: "quota",
          accountPoolStickyLimit: 1,
        });
      }
      if (url.endsWith("/api/codex-auth/pool-strategy") && (method === "PUT" || method === "PATCH")) {
        return Response.json({
          ok: true,
          accountPoolStrategy: "quota",
          accountPoolStickyLimit: 1,
        });
      }
      if (url.endsWith("/api/codex-auth/auto-switch") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { threshold: number };
        writes.push(body.threshold);
        const response = putResponses.shift();
        if (!response) throw new Error("unexpected auto-switch write");
        return await response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    };
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchRouter });

    const container = document.createElement("div");
    document.body.append(container);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container);
    mountedRoot = root;
    await act(async () => {
      root.render(
        <LanguageProvider>
          <CodexAccountPool apiBase="http://localhost" />
        </LanguageProvider>,
      );
      await flush();
    });

    const toggle = container.querySelector<HTMLButtonElement>("button.toggle[aria-pressed]");
    expect(toggle).toBeNull();
    expect(writes).toEqual([]);

    await act(async () => {
      active.resolve(Response.json({
        activeCodexAccountId: null,
        autoSwitchThreshold: 55,
        accountPoolStrategy: "quota",
        accountPoolStickyLimit: 1,
      }));
      await flush();
    });

    const advanced = container.querySelector<HTMLButtonElement>(".codex-auth-advanced__toggle");
    expect(advanced).not.toBeNull();
    await act(async () => { advanced!.click(); await flush(); });

    const readyToggle = container.querySelector<HTMLButtonElement>("button.toggle[aria-pressed]");
    expect(readyToggle?.disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Usage threshold, percent"]')?.value).toBe("55");
    expect(writes).toEqual([]);
    expect(refreshCallback).not.toBeNull();
  });

  test("Enter then blur issues exactly one write", async () => {
    const harness = await mountHarness();
    const write = deferred<Response>();
    harness.enqueuePut(write.promise);

    await act(async () => {
      harness.input.focus();
      setInputValue(harness.input, "95");
      keyDown(harness.input, "Enter");
      harness.outsideButton.focus();
      await Promise.resolve();
    });

    expect(harness.writes).toEqual([95]);
    await act(async () => {
      write.resolve(new Response(null, { status: 204 }));
      await flush();
    });
    expect(harness.input.value).toBe("95");
    expect(harness.container.querySelector("#codex-auto-switch-feedback")?.textContent).toContain("updated");
    expect(harness.writes).toEqual([95]);
  });

  test("stale 30-second refresh cannot overwrite a successful edit", async () => {
    const harness = await mountHarness();
    const staleRead = deferred<Response>();
    const write = deferred<Response>();
    harness.enqueueActive(staleRead.promise);
    harness.enqueuePut(write.promise);

    await act(async () => {
      harness.refresh();
      await Promise.resolve();
      harness.input.focus();
      setInputValue(harness.input, "95");
      keyDown(harness.input, "Enter");
      await Promise.resolve();
    });
    expect(harness.writes).toEqual([95]);

    await act(async () => {
      write.resolve(new Response(null, { status: 204 }));
      await flush();
      staleRead.resolve(Response.json({ activeCodexAccountId: null, autoSwitchThreshold: 80 }));
      await flush();
    });

    expect(harness.input.value).toBe("95");
    expect(harness.container.textContent).toContain("95% usage or above");
    expect(harness.writes).toEqual([95]);
  });

  test("failed write restores the last confirmed value", async () => {
    const harness = await mountHarness();
    harness.enqueuePut(new Response(null, { status: 500 }));

    await act(async () => {
      harness.input.focus();
      setInputValue(harness.input, "95");
      keyDown(harness.input, "Enter");
      await flush();
    });

    expect(harness.input.value).toBe("80");
    expect(harness.container.textContent).toContain("80% usage or above");
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed");
    expect(harness.writes).toEqual([95]);
  });

  test("Escape cancels without writing", async () => {
    const harness = await mountHarness();

    await act(async () => {
      harness.input.focus();
      setInputValue(harness.input, "95");
      keyDown(harness.input, "Escape");
      harness.outsideButton.focus();
      await flush();
    });

    expect(harness.input.value).toBe("80");
    expect(harness.writes).toEqual([]);
    expect(harness.container.querySelector("#codex-auto-switch-feedback")).toBeNull();
  });

  test("pointer toggle disables a dirty valid draft before blur can commit it", async () => {
    const harness = await mountHarness();
    harness.enqueuePut(new Response(null, { status: 204 }));
    harness.enqueuePut(new Response(null, { status: 204 }));

    await act(async () => {
      harness.input.focus();
      setInputValue(harness.input, "95");
      await flush();
    });

    const dirtyInput = harness.currentInput();
    expect(dirtyInput).not.toBeNull();
    expect(dirtyInput?.value).toBe("95");

    await act(async () => {
      pointerToggleAfterNullTargetBlur(dirtyInput!, harness.currentToggle());
      await flush();
    });

    expect(harness.writes).toEqual([0]);
    expect(harness.currentInput()).toBeNull();
    expect(harness.currentToggle().getAttribute("aria-pressed")).toBe("false");
    expect(harness.container.textContent).toContain("Usage-based proactive switching is off");
    expect(harness.container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      harness.currentToggle().click();
      await flush();
    });

    expect(harness.writes).toEqual([0, 95]);
    expect(harness.currentInput()?.value).toBe("95");
    expect(harness.currentToggle().getAttribute("aria-pressed")).toBe("true");
    expect(harness.container.textContent).toContain("95% usage or above");
  });

  test("pointer toggle disables an empty draft and restores the default", async () => {
    const harness = await mountHarness();
    harness.enqueuePut(new Response(null, { status: 204 }));
    harness.enqueuePut(new Response(null, { status: 204 }));

    await act(async () => {
      harness.input.focus();
      setInputValue(harness.input, "");
      await flush();
    });

    const emptyInput = harness.currentInput();
    expect(emptyInput).not.toBeNull();
    expect(emptyInput?.value).toBe("");

    await act(async () => {
      pointerToggleAfterNullTargetBlur(emptyInput!, harness.currentToggle());
      await flush();
    });

    expect(harness.writes).toEqual([0]);
    expect(harness.currentInput()).toBeNull();
    expect(harness.currentToggle().getAttribute("aria-pressed")).toBe("false");
    expect(harness.container.textContent).toContain("Usage-based proactive switching is off");
    expect(harness.container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      harness.currentToggle().click();
      await flush();
    });

    expect(harness.writes).toEqual([0, 80]);
    expect(harness.currentInput()?.value).toBe("80");
    expect(harness.currentToggle().getAttribute("aria-pressed")).toBe("true");
    expect(harness.container.textContent).toContain("80% usage or above");
  });

  /*
   * Alignment structure. The 20px toggle used to sit directly in a bottom-aligned row beside
   * the 32px threshold compound, so their centres were 6px apart — what read as a switch
   * height bug. The toggle now lives in a slot that matches the compound's height.
   *
   * happy-dom does no real layout, so this asserts the structure that produces the alignment;
   * the resulting centre line is measured in a real browser against the running build.
   */
  test("the toggle sits in a height-matched slot rather than directly in the bottom-aligned row", async () => {
    const harness = await mountHarness();

    const slot = harness.container.querySelector(".codex-auto-switch-toggle-slot");
    expect(slot).not.toBeNull();
    // Inside the slot, not a direct child of the row — that nesting is what supplies the
    // matching 32px height and therefore the shared centre line.
    expect(slot!.querySelector("button.toggle[aria-pressed]")).not.toBeNull();
    expect(harness.container.querySelector(".codex-auto-switch-controls > button.toggle")).toBeNull();
  });
});
