/**
 * The native passthrough switch lives under the Claude account pool: it reads the global Claude Code
 * setting, saves only that one field, and reconciles with the runtime after an ambiguous save.
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

function stubClaudeCode(
  get: { nativePassthrough?: boolean } | "fail" | (() => Response | Promise<Response>),
  put?: number | { nativePassthrough?: boolean },
): { puts: Record<string, unknown>[] } {
  const calls = { puts: [] as Record<string, unknown>[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).endsWith("/api/claude-code")) throw new Error("unexpected fetch");
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.puts.push(body);
      if (typeof put === "number") return new Response(null, { status: put });
      return Response.json({ enabled: true, ...(put ?? body) });
    }
    if (typeof get === "function") return get();
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

const toggleOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button.toggle")!;
const retryOf = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("button")]
  .find(button => button.textContent === DICTS.en["common.retry"])!;

describe("Claude native passthrough setting", () => {
  test.each(Object.entries(DICTS))("%s copy puts Claude picker and Desktop aliases ahead of modelMap", (locale, dict) => {
    const descriptions: Record<string, RegExp> = {
      de: /Modellauswahl.*Claude Desktop.*vor modelMap/,
      en: /Claude picker.*Claude Desktop.*before modelMap/,
      fr: /sélecteur.*Claude Desktop.*avant modelMap/,
      ja: /モデルピッカー.*Claude Desktop.*modelMap より先/,
      ko: /모델 선택기.*Claude Desktop.*modelMap보다 먼저/,
      pt: /seletor.*Claude Desktop.*antes de modelMap/,
      ru: /выбора моделей.*Claude Desktop.*до modelMap/,
      tr: /model seçici.*Claude Desktop.*modelMap öncesinde/,
      vi: /bộ chọn.*Claude Desktop.*trước modelMap/,
      zh: /模型选择器.*Claude Desktop.*先于 modelMap/,
      "zh-TW": /模型選擇器.*Claude Desktop.*先於 modelMap/,
    };
    expect(dict["claude.nativePassthroughDesc"]).toMatch(descriptions[locale]!);
  });

  test("a runtime that omits nativePassthrough leaves the switch disabled and reports a load error", async () => {
    const calls = stubClaudeCode({});
    const host = await mount();
    expect(toggleOf(host).disabled).toBe(true);
    expect(toggleOf(host).hasAttribute("aria-pressed")).toBe(false);
    expect(host.textContent).toContain(DICTS.en["claude.nativePassthrough"]);
    expect(host.textContent).toContain(DICTS.en["claude.nativePassthroughLoadFailed"]);
    await act(async () => { toggleOf(host).click(); await flush(); });
    expect(calls.puts).toHaveLength(0);
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

  test.each([500, {}, { nativePassthrough: true }])("a failed or unconfirmed save (%j) disables the switch until a live read", async put => {
    const live = Promise.withResolvers<Response>();
    let reads = 0;
    const calls = stubClaudeCode(() => ++reads === 1 ? Response.json({ nativePassthrough: true }) : live.promise, put);
    const host = await mount();
    await act(async () => { toggleOf(host).click(); await flush(); });
    expect(toggleOf(host).disabled).toBe(true);
    expect(toggleOf(host).hasAttribute("aria-pressed")).toBe(false);
    expect(reads).toBe(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(DICTS.en["claude.saveFailed"]);
    await act(async () => { toggleOf(host).click(); await flush(); });
    expect(calls.puts).toEqual([{ nativePassthrough: false }]);
    await act(async () => { live.resolve(Response.json({ nativePassthrough: false })); await flush(); });
    expect(toggleOf(host).disabled).toBe(false);
    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("false");
  });

  test("Retry reads again after a failed reconciliation and restores the live value", async () => {
    let reads = 0;
    const calls = stubClaudeCode(() => {
      reads += 1;
      if (reads === 2) return new Response(null, { status: 503 });
      return Response.json({ nativePassthrough: reads === 1 });
    }, 500);
    const host = await mount();
    await act(async () => { toggleOf(host).click(); await flush(); });
    expect(toggleOf(host).disabled).toBe(true);
    expect(host.textContent).toContain(DICTS.en["claude.nativePassthroughLoadFailed"]);
    await act(async () => { retryOf(host).click(); await flush(); });
    expect(toggleOf(host).disabled).toBe(false);
    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("false");
    expect(reads).toBe(3);
    expect(calls.puts).toEqual([{ nativePassthrough: false }]);
  });

  test("a failed load disables the switch, says why, and Retry loads it again", async () => {
    stubClaudeCode("fail");
    const host = await mount();
    expect(host.querySelector<HTMLButtonElement>("button.toggle")!.disabled).toBe(true);
    expect(host.textContent).toContain(DICTS.en["claude.nativePassthroughLoadFailed"]);
    stubClaudeCode({ nativePassthrough: false });
    await act(async () => { retryOf(host).click(); await flush(); });
    expect(toggleOf(host).disabled).toBe(false);
    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("false");
  });
});
