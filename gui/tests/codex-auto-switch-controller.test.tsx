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
    Response.json({ activeCodexAccountId: null, autoSwitchThreshold: 80 }),
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

  const fetchRouter = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.endsWith("/api/codex-auth/accounts") && method === "GET") {
      return Response.json({ accounts: [] });
    }
    if (url.endsWith("/api/codex-auth/active") && method === "GET") {
      const response = activeResponses.shift();
      if (!response) throw new Error("unexpected active-account read");
      return await response;
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

  const input = container.querySelector<HTMLInputElement>('input[aria-label="Switch threshold, percent"]');
  expect(input).not.toBeNull();
  expect(input?.value).toBe("80");
  expect(input?.readOnly).toBe(false);
  expect(refreshCallback).not.toBeNull();

  return {
    container,
    outsideButton,
    root,
    input: input!,
    writes,
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
    expect(harness.container.querySelector('[role="status"]')?.textContent).toContain("updated");
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
    expect(harness.container.querySelector('[role="status"]')).toBeNull();
  });
});
