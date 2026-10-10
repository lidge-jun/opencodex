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
let pairingSessionHtml: string | null = null;
let pairingStatus = 401;
let linkStatusCode = 200;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mountWindow(
  role: "standalone" | "hub",
  options: { session?: boolean; url?: string; managementAuthRequired?: boolean; linkStatusCode?: number; language?: string } = {},
): void {
  const url = options.url ?? "http://localhost/#remote";
  const session = options.session ?? true;
  linkStatusCode = options.linkStatusCode ?? 200;
  testWindow = new Window({ url });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: options.language ?? "en-US" });
  const head = testWindow.document.head;
  const metaEntries: Array<readonly [string, string]> = [
    ["opencodex-runtime-role", role],
    ...(options.managementAuthRequired !== undefined ? [["opencodex-management-auth-required", options.managementAuthRequired ? "1" : "0"]] as const : []),
    ...(session ? [
      ["opencodex-session-token", "ocx_session_route_test"],
      ["opencodex-session-csrf", "route-test-csrf"],
      ["opencodex-session-origin", new URL(url).origin],
      ["opencodex-session-server-origin", new URL(url).origin],
    ] as const : []),
  ];
  for (const [name, content] of metaEntries) {
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
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/opencodex-session") && init?.method === "POST") {
      if (pairingSessionHtml) return new Response(pairingSessionHtml, { status: 200, headers: { "content-type": "text/html" } });
      return new Response(null, { status: pairingStatus });
    }
    if (url.includes("/api/link/status")) {
      linkStatusReads += 1;
      if (linkStatusCode !== 200) return jsonResponse({ error: { code: linkStatusCode === 403 ? "forbidden" : "unknown" } }, linkStatusCode);
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
  pairingSessionHtml = null;
  pairingStatus = 401;
  linkStatusCode = 200;
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

async function mountApp(): Promise<void> {
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

test("an authenticated remote hub without a GUI session offers one-time pairing", async () => {
  mountWindow("hub", {
    session: false,
    url: "https://opencodex.rhodiz.net/#remote",
    managementAuthRequired: true,
  });
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
  await waitFor(() => (container.textContent ?? "").includes("Sign in to the local dashboard session"));
  expect(container.textContent).toContain("Sign in to the local dashboard session");
  expect(container.textContent).toContain("Connect this dashboard to the hub");
  expect(container.querySelector(".connect-pairing")).toBeNull();
  const action = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Connect this dashboard to the hub");
  await act(async () => { action?.click(); });
  expect(container.textContent).toContain('ocx gui pair --origin "https://opencodex.rhodiz.net"');
  expect(linkStatusReads).toBe(0);
});

test("the exact missing-session screenshot scenario shows pairing recovery when management auth is not required", async () => {
  mountWindow("hub", { session: false, url: "https://opencodex.rhodiz.net/#remote", managementAuthRequired: false, language: "vi-VN" });
  await mountApp();
  await waitFor(() => container.textContent?.includes("Đăng nhập phiên bảng điều khiển cục bộ để quản lý liên kết") === true);
  expect(container.textContent).toContain("Kết nối dashboard này với hub");
  expect(container.querySelector(".connect-pairing")).toBeNull();
  const action = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Kết nối dashboard này với hub");
  expect(action).toBeDefined();
  await act(async () => { action?.click(); });
  expect(container.querySelector(".connect-pairing")).not.toBeNull();
});

test("a valid but insufficient Hub session offers recovery after Remote Link rejects it", async () => {
  mountWindow("hub", { url: "https://opencodex.rhodiz.net/#remote", managementAuthRequired: false, linkStatusCode: 403 });
  await mountApp();
  await waitFor(() => container.textContent?.includes("This dashboard session cannot manage remote links") === true);
  expect(container.querySelector('[role="switch"]')).not.toBeNull();
  expect(container.textContent).toContain("Connect this dashboard to the hub");
  expect(container.querySelector(".connect-pairing")).toBeNull();
});

test("a paired operator Hub session does not show recovery when Remote Link authorization succeeds", async () => {
  mountWindow("hub", { url: "https://opencodex.rhodiz.net/#remote", managementAuthRequired: false, linkStatusCode: 200 });
  await mountApp();
  await waitFor(() => linkStatusReads > 0);
  expect(container.querySelector('[role="switch"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Connect this dashboard to the hub");
});

test("an expired pairing grant keeps the recovery form open and explains how to recover", async () => {
  mountWindow("hub", { session: false, url: "https://opencodex.rhodiz.net/#remote", managementAuthRequired: false });
  await mountApp();
  await waitFor(() => container.textContent?.includes("Connect this dashboard to the hub") === true);
  const action = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Connect this dashboard to the hub");
  await act(async () => { action?.click(); });
  const input = container.querySelector("#connect-pairing-code") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, `ocx_pair_${"a".repeat(43)}`);
  await act(async () => { input.dispatchEvent(new testWindow.Event("input", { bubbles: true })); });
  await act(async () => { input.closest("form")!.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true })); });
  await waitFor(() => container.querySelector('[role="alert"]') !== null);
  expect(container.querySelector(".connect-pairing")).not.toBeNull();
  expect(container.textContent).toContain("different browser origin");
});

test("a redeemed code does not close recovery until the new session can manage Remote Link", async () => {
  mountWindow("hub", { session: false, url: "https://opencodex.rhodiz.net/#remote", managementAuthRequired: false, linkStatusCode: 403 });
  await mountApp();
  await waitFor(() => container.textContent?.includes("Connect this dashboard to the hub") === true);
  const action = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Connect this dashboard to the hub");
  await act(async () => { action?.click(); });
  pairingSessionHtml = `<meta name="opencodex-session-token" content="ocx_session_operator_pairing"><meta name="opencodex-session-csrf" content="operator-csrf"><meta name="opencodex-session-origin" content="https://opencodex.rhodiz.net"><meta name="opencodex-session-server-origin" content="https://opencodex.rhodiz.net">`;
  const input = container.querySelector("#connect-pairing-code") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, `ocx_pair_${"a".repeat(43)}`);
  await act(async () => { input.dispatchEvent(new testWindow.Event("input", { bubbles: true })); });
  await act(async () => { input.closest("form")!.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true })); });
  await waitFor(() => container.querySelector('[role="alert"]') !== null);
  expect(container.querySelector(".connect-pairing")).not.toBeNull();
  expect(container.textContent).toContain("still cannot manage Remote Link");
});

test("an authenticated remote hub with an automatic session can open manual pairing", async () => {
  mountWindow("hub", {
    url: "https://opencodex.rhodiz.net/#remote",
    managementAuthRequired: false,
    linkStatusCode: 403,
  });
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
  await waitFor(() => container.querySelector('[role="switch"]') !== null);
  await waitFor(() => container.textContent?.includes("Connect this dashboard to the hub") === true);
  expect(container.querySelector(".connect-pairing")).toBeNull();
  expect(container.querySelector('[role="switch"]')).not.toBeNull();

  const pairingButton = [...container.querySelectorAll("button")]
    .find(button => button.textContent?.trim() === "Connect this dashboard to the hub");
  expect(pairingButton).toBeDefined();
  await act(async () => { pairingButton?.click(); });

  expect(container.querySelector(".connect-pairing")).not.toBeNull();
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(container.textContent).toContain('ocx gui pair --origin "https://opencodex.rhodiz.net"');

  const readsBeforePairing = linkStatusReads;
  linkStatusCode = 200;
  pairingSessionHtml = `<meta name="opencodex-session-token" content="ocx_session_operator_pairing"><meta name="opencodex-session-csrf" content="operator-csrf"><meta name="opencodex-session-origin" content="https://opencodex.rhodiz.net"><meta name="opencodex-session-server-origin" content="https://opencodex.rhodiz.net">`;
  const input = container.querySelector("#connect-pairing-code") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, `ocx_pair_${"a".repeat(43)}`);
  await act(async () => { input.dispatchEvent(new testWindow.Event("input", { bubbles: true })); });
  await act(async () => { input.closest("form")!.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true })); });
  await waitFor(() => container.querySelector(".connect-pairing") === null && container.querySelector('[role="switch"]') !== null);
  expect(linkStatusReads).toBeGreaterThan(readsBeforePairing);
});

test("a non-loopback standalone without a GUI session does not offer hub pairing", async () => {
  mountWindow("standalone", {
    session: false,
    url: "https://standalone.example.test/#remote",
    managementAuthRequired: true,
  });
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
  await waitFor(() => (container.textContent ?? "").includes("Sign in to the local dashboard session"));
  expect(container.textContent).not.toContain("Connect this dashboard to the hub");
  expect(container.textContent).not.toContain("ocx gui pair --origin");
  expect(linkStatusReads).toBe(0);
});
