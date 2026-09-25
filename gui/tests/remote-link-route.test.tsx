import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

/**
 * The Home and a standalone Child reach Remote Link through their own loopback dashboard session.
 * Gating the page on a connected-client target left both on the sign-in notice forever, because
 * only a Child that is already connected has one; a fixture that pretended to be a client hid it.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let linkStatusReads = 0;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mountWindow(role: "standalone" | "hub"): void {
  testWindow = new Window({ url: "http://localhost/#remote" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  const head = testWindow.document.head;
  for (const [name, content] of [
    ["opencodex-runtime-role", role],
    ["opencodex-session-token", "ocx_session_route_test"],
    ["opencodex-session-csrf", "route-test-csrf"],
    ["opencodex-session-origin", "http://localhost"],
    ["opencodex-session-server-origin", "http://localhost"],
  ] as const) {
    const meta = testWindow.document.createElement("meta");
    meta.setAttribute("name", name);
    meta.setAttribute("content", content);
    head.appendChild(meta);
  }
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).__APP_VERSION__ = "0.0.0-test";
  const mockFetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/link/status")) {
      linkStatusReads += 1;
      return jsonResponse({ role: "standalone", listener: { state: "off", port: null }, links: [], child: null });
    }
    if (url.includes("/api/machine/status")) return jsonResponse({}, 404);
    if (url.includes("/api/remote-workspace")) return jsonResponse({ available: false });
    if (url.includes("/healthz")) return jsonResponse({ status: "ok", version: "0.0.0-test", uptime: 1 });
    return jsonResponse({});
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  linkStatusReads = 0;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  const { resetApiAuthFetchForTests } = await import("../src/api");
  resetApiAuthFetchForTests();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
  }
}

for (const role of ["standalone", "hub"] as const) {
  test(`a ${role} dashboard opens Remote Link with its own session`, async () => {
    mountWindow(role);
    const { resetApiAuthFetchForTests, installApiAuthFetch } = await import("../src/api");
    resetApiAuthFetchForTests();
    installApiAuthFetch();
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });
    const [{ createRoot }, { LanguageProvider }, { default: App }] = await Promise.all([
      import("react-dom/client"),
      import("../src/i18n/provider"),
      import("../src/App"),
    ]);
    await act(async () => {
      root = createRoot(container);
      root.render(<LanguageProvider><App /></LanguageProvider>);
    });
    await waitFor(() => container.querySelector('.remote-link-page [role="switch"], [role="switch"]') !== null || (container.textContent ?? "").includes("Sign in to the local dashboard session"));
    expect(container.textContent).not.toContain("Sign in to the local dashboard session");
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
    expect(linkStatusReads).toBeGreaterThan(0);
  });
}
