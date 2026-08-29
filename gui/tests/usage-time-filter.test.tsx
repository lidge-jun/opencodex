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

function localDateInputValue(date: Date, endOfDay: boolean): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}T${endOfDay ? "23:59" : "00:00"}`;
}

test("usage keeps quick days inside a floating custom picker and applies them once", async () => {
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
  expect(buttons().some(button => button.textContent?.trim() === "Today")).toBe(false);
  expect(buttons().some(button => button.textContent?.trim() === "Yesterday")).toBe(false);
  expect(buttons().some(button => button.textContent?.trim() === "7d")).toBe(true);
  expect(buttons().some(button => button.textContent?.trim() === "30d")).toBe(true);

  const custom = buttons().find(button => button.textContent?.trim() === "Custom...");
  expect(custom).toBeTruthy();
  await act(async () => { custom!.click(); });
  const countAfterOpen = urls.length;
  const popover = container.querySelector<HTMLElement>('.usage-custom-popover[role="dialog"]');
  expect(popover).toBeTruthy();
  const quick = popover!.querySelector<HTMLSelectElement>("#usage-custom-quick");
  expect(quick).toBeTruthy();

  const today = new Date();
  await act(async () => {
    quick!.value = "today";
    quick!.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  expect(urls).toHaveLength(countAfterOpen);

  const inputs = Array.from(popover!.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'));
  expect(inputs).toHaveLength(2);
  expect(inputs[0]!.value).toBe(localDateInputValue(today, false));
  expect(inputs[1]!.value).toBe(localDateInputValue(today, true));
  const apply = buttons().find(button => button.textContent?.trim() === "Apply");
  expect(apply).toBeTruthy();
  expect(apply!.disabled).toBe(false);
  await act(async () => { apply!.click(); });
  await waitFor(() => urls.length === countAfterOpen + 1);
  const applied = new URL(urls.at(-1)!);
  expect(applied.searchParams.get("since")).toBe(localDateInputValue(today, false));
  expect(applied.searchParams.get("until")).toBe(localDateInputValue(today, true));
  expect(container.querySelector(".usage-custom-popover")).toBeNull();

  await act(async () => { root.unmount(); });
  container.remove();
});
