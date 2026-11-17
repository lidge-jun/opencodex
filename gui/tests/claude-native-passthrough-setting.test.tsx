/**
 * The native passthrough switch lives under the Claude account pool: it reads the global Claude Code
 * setting, saves only that one field, and keeps the shown state when a save fails.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ClaudeNativePassthroughSetting from "../src/components/provider-workspace/ClaudeNativePassthroughSetting";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS } from "../src/i18n/shared";

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let mountedRoots: Root[];

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://proxy/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  mountedRoots = [];
});

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => { root.unmount(); });
  }
  for (const key of domGlobals) {
    const descriptor = previousDomGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  await testWindow.happyDOM?.close?.();
});

/** GET answers with the stored value (or fails); PUT answers per the supplied status. */
function stubClaudeCode(get: { nativePassthrough?: boolean } | "fail", putStatus = 200): { puts: Record<string, unknown>[] } {
  const calls = { puts: [] as Record<string, unknown>[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/api/claude-code")) throw new Error("unexpected fetch");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.puts.push(body);
      return putStatus === 200 ? Response.json({ enabled: true, ...body }) : new Response(null, { status: putStatus });
    }
    if (get === "fail") return new Response(null, { status: 500 });
    return Response.json({ enabled: true, ...get });
  }) as typeof fetch;
  return calls;
}

async function mount(): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <ClaudeNativePassthroughSetting apiBase="http://proxy" />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
}

const toggleOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button[aria-pressed]")!;

describe("Claude native passthrough setting", () => {
  test("reads the stored value, defaulting a missing field to on", async () => {
    stubClaudeCode({});
    const host = await mount();
    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain(DICTS.en["claude.nativePassthrough"]);
    expect(host.textContent).toContain(DICTS.en["claude.nativePassthroughDesc"]);
  });

  test("a click saves only the passthrough field and shows the saved value", async () => {
    const calls = stubClaudeCode({ nativePassthrough: true });
    const host = await mount();
    await act(async () => { toggleOf(host).click(); await flush(); });
    expect(calls.puts).toEqual([{ nativePassthrough: false }]);
    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("false");
    await act(async () => { toggleOf(host).click(); await flush(); });
    expect(calls.puts).toEqual([{ nativePassthrough: false }, { nativePassthrough: true }]);
    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("true");
  });

  test("a failed save keeps the shown state and reports it", async () => {
    stubClaudeCode({ nativePassthrough: true }, 500);
    const host = await mount();
    await act(async () => { toggleOf(host).click(); await flush(); });
    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(DICTS.en["claude.saveFailed"]);
  });

  test("a failed load disables the switch, says why, and Retry loads it again", async () => {
    stubClaudeCode("fail");
    const host = await mount();
    expect(host.querySelector<HTMLButtonElement>("button.toggle")!.disabled).toBe(true);
    expect(host.textContent).toContain(DICTS.en["claude.nativePassthroughLoadFailed"]);
    stubClaudeCode({ nativePassthrough: false });
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === DICTS.en["common.retry"])!;
    await act(async () => { retry.click(); await flush(); });
    expect(toggleOf(host).disabled).toBe(false);
    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("false");
  });
});
