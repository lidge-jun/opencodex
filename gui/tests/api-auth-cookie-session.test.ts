import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installApiAuthFetch, resetApiAuthFetchForTests } from "../src/api";

const globals = ["document", "window", "navigator", "sessionStorage", "localStorage", "fetch"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let promptCalls: number;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://100.88.9.100:10101/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    localStorage: { configurable: true, value: testWindow.localStorage },
    fetch: { configurable: true, value: testWindow.fetch.bind(testWindow) },
  });
  promptCalls = 0;
  resetApiAuthFetchForTests(async () => {
    promptCalls += 1;
    return null;
  });
});

afterEach(() => {
  resetApiAuthFetchForTests();
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function installMockAuthFetch(handler: typeof fetch): Promise<void> {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: handler });
  Object.defineProperty(window, "fetch", { configurable: true, value: handler });
  installApiAuthFetch();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pathnameOf(input: RequestInfo | URL): string {
  return new URL(input instanceof Request ? input.url : String(input), window.location.href).pathname;
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

test("a persisted opaque session is origin-scoped and re-arms dashboard requests without a prompt", async () => {
  const session = {
    token: "ocx_session_saved",
    csrfToken: "saved-csrf",
    origin: window.location.origin,
    expiresAt: Date.now() + 60_000,
  };
  localStorage.setItem("opencodex-gui-session", JSON.stringify(session));
  const seen: Array<{ path: string; key: string | null; origin: string | null; csrf: string | null; cookie: string | null }> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = headersOf(input, init);
    seen.push({
      path: pathnameOf(input),
      key: headers.get("X-OpenCodex-API-Key"),
      origin: headers.get("X-OpenCodex-GUI-Origin"),
      csrf: headers.get("X-OpenCodex-CSRF-Token"),
      cookie: headers.get("Cookie"),
    });
    return jsonResponse({});
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(200);
  expect((await fetch("/api/providers", { method: "POST", body: "{}" })).status).toBe(200);
  expect(promptCalls).toBe(0);
  expect(seen).toEqual([
    { path: "/api/config", key: "ocx_session_saved", origin: window.location.origin, csrf: null, cookie: null },
    { path: "/api/providers", key: "ocx_session_saved", origin: window.location.origin, csrf: "saved-csrf", cookie: null },
  ]);
});

test("admin-token sign-in persists only the opaque session returned by the remote listener", async () => {
  resetApiAuthFetchForTests(async () => {
    promptCalls += 1;
    return "admin-token";
  });
  const seenKeys: string[] = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathnameOf(input);
    const headers = headersOf(input, init);
    const key = headers.get("X-OpenCodex-API-Key");
    if (path === "/opencodex-session") return new Response("missing", { status: 404 });
    if (path === "/api/auth/session") {
      expect(init?.method).toBe("POST");
      expect(key).toBe("admin-token");
      return jsonResponse({
        token: "ocx_session_minted",
        csrfToken: "minted-csrf",
        origin: window.location.origin,
        expiresAt: Date.now() + 60_000,
      });
    }
    seenKeys.push(key ?? "");
    return key === "ocx_session_minted" ? jsonResponse({}) : new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(1);
  expect(seenKeys).toEqual(["", "ocx_session_minted"]);
  const persisted = localStorage.getItem("opencodex-gui-session") ?? "";
  expect(persisted).toContain("ocx_session_minted");
  expect(persisted).not.toContain("admin-token");
});

test("a failed session mint keeps the raw admin token in memory only for the current page", async () => {
  resetApiAuthFetchForTests(async () => {
    promptCalls += 1;
    return "admin-token";
  });
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathnameOf(input);
    const key = headersOf(input, init).get("X-OpenCodex-API-Key");
    if (path === "/opencodex-session") return new Response("missing", { status: 404 });
    if (path === "/api/auth/session") return new Response("mint refused", { status: 403 });
    return key === "admin-token" ? jsonResponse({}) : new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(1);
  expect(localStorage.getItem("opencodex-gui-session")).toBeNull();
});

test("a rejected persisted session is removed before the next prompt", async () => {
  localStorage.setItem("opencodex-gui-session", JSON.stringify({
    token: "ocx_session_expired",
    csrfToken: "csrf",
    origin: window.location.origin,
    expiresAt: Date.now() + 60_000,
  }));
  const mockFetch = (async (input: RequestInfo | URL) => {
    if (pathnameOf(input) === "/opencodex-session") return new Response("missing", { status: 404 });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(401);
  expect(promptCalls).toBe(1);
  expect(localStorage.getItem("opencodex-gui-session")).toBeNull();
});
