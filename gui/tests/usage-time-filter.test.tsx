import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Usage from "../src/pages/Usage";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const usagePayload = {
  range: "30d", surface: "all", since: null, generatedAt: 1,
  summary: {
    requests: 0, measuredRequests: 0, reportedRequests: 0, unreportedRequests: 0,
    unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 0, outputTokens: 0,
    cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, coverageRatio: 1,
  },
  days: [], models: [], providers: [], historyTruncated: false,
  truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0,
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
  }
}

test("usage range controls request yesterday and apply custom bounds only after Apply", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async input => {
    urls.push(String(input));
    return Response.json(usagePayload);
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Usage apiBase="http://usage.test" /></LanguageProvider>);
  });
  await waitFor(() => urls.length === 1);

  const buttons = () => Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const yesterday = buttons().find(button => button.textContent?.trim() === "Yesterday");
  expect(yesterday).toBeTruthy();
  await act(async () => { yesterday!.click(); });
  await waitFor(() => urls.length === 2);
  expect(new URL(urls[1]!).searchParams.get("range")).toBe("yesterday");

  const custom = buttons().find(button => button.textContent?.trim() === "Custom...");
  expect(custom).toBeTruthy();
  await act(async () => { custom!.click(); });
  const countAfterOpen = urls.length;
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>(".usage-custom-time-picker input"));
  expect(inputs).toHaveLength(2);
  const apply = buttons().find(button => button.textContent?.trim() === "Apply");
  expect(apply).toBeTruthy();
  expect(apply!.disabled).toBe(true);
  const valueSetter = Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")?.set;
  expect(valueSetter).toBeTruthy();
  await act(async () => {
    valueSetter!.call(inputs[0], "2026-08-29T09:17");
    inputs[0]!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    valueSetter!.call(inputs[1], "2026-08-30T04:23");
    inputs[1]!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  expect(urls).toHaveLength(countAfterOpen);
  expect(apply!.disabled).toBe(false);
  await act(async () => { apply!.click(); });
  await waitFor(() => urls.length === countAfterOpen + 1);
  const applied = new URL(urls.at(-1)!);
  expect(applied.searchParams.get("since")).toBe("2026-08-29T09:17");
  expect(applied.searchParams.get("until")).toBe("2026-08-30T04:23");

  await act(async () => { root.unmount(); });
  container.remove();
});
