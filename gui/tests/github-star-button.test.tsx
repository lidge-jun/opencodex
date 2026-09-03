import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { GithubStarButton } from "../src/components/github-star-button";

/**
 * The star action left the sidebar (a promotion ask at the same weight as the proxy kill
 * switch, polling gh on every page) and now lives in the update dialog. This pins what the
 * move must preserve: the poll starts on mount, a click POSTs, the label settles, and
 * unmounting stops the poll.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
let root: Root | null = null;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#dashboard" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers({ now: 1_700_000_000_000 });
  clearClientResourceStoresForTests();
});

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

test("GithubStarButton: polls on mount, POSTs on click, settles to starred, stops on unmount", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let state: "not-starred" | "starred" = "not-starred";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.endsWith("/api/github/star") && method === "POST") {
      state = "starred";
      return new Response(JSON.stringify({ ok: true, state }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/github/star")) {
      return new Response(JSON.stringify({ state, url: "https://github.com/lidge-jun/opencodex" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root!.render(<LanguageProvider><GithubStarButton apiBase="http://proxy" /></LanguageProvider>);
  });
  await flush();

  const button = container.querySelector<HTMLButtonElement>("button.github-star-button")!;
  expect(button).not.toBeNull();
  expect(calls.filter(c => c.method === "GET" && c.url.endsWith("/api/github/star"))).toHaveLength(1);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.textContent).toContain("Star on GitHub");

  await act(async () => { button.click(); });
  await flush();
  expect(calls.filter(c => c.method === "POST")).toHaveLength(1);
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.textContent).toContain("Starred on GitHub");
  expect(button.disabled).toBe(true);

  // Unmount, then advance past the poll interval: no further GETs.
  const getsBefore = calls.filter(c => c.method === "GET").length;
  await act(async () => { root!.unmount(); });
  root = null;
  await act(async () => { jest.advanceTimersByTime(6 * 60_000); });
  await flush();
  expect(calls.filter(c => c.method === "GET").length).toBe(getsBefore);
});

test("GithubStarButton: unauthenticated gh opens the repo page instead of POSTing", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/github/star")) {
      return new Response(JSON.stringify({ state: "unauthenticated" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const opened: string[] = [];
  testWindow.open = ((url: string) => { opened.push(url); return null; }) as unknown as typeof testWindow.open;

  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root!.render(<LanguageProvider><GithubStarButton apiBase="http://proxy" /></LanguageProvider>);
  });
  await flush();
  const button = container.querySelector<HTMLButtonElement>("button.github-star-button")!;
  expect(button.textContent).toContain("Open GitHub to star");
  await act(async () => { button.click(); });
  await flush();
  expect(calls.some(c => c.startsWith("POST"))).toBe(false);
  expect(opened).toEqual(["https://github.com/lidge-jun/opencodex"]);
});
