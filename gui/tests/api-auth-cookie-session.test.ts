import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installApiAuthFetch, resetApiAuthFetchForTests } from "../src/api";

const globals = ["document", "window", "navigator", "sessionStorage", "fetch"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let promptCalls: number;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
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
  return new URL(input instanceof Request ? input.url : String(input), "http://localhost/").pathname;
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

test("cookie arm on install arms origin/CSRF headers with no API key", async () => {
  let armCalls = 0;
  const seen: Array<{ path: string; method: string; key: string | null; origin: string | null; csrf: string | null }> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (pathnameOf(input) === "/api/auth/session") {
      armCalls += 1;
      return jsonResponse({ csrfToken: "cookie-csrf", origin: "http://localhost", expiresAt: 123 });
    }
    const headers = headersOf(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    seen.push({
      path: pathnameOf(input),
      method,
      key: headers.get("X-OpenCodex-API-Key"),
      origin: headers.get("X-OpenCodex-GUI-Origin"),
      csrf: headers.get("X-OpenCodex-CSRF-Token"),
    });
    if (!headers.get("X-OpenCodex-API-Key") && headers.get("X-OpenCodex-GUI-Origin") === "http://localhost") {
      return jsonResponse({});
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(200);
  expect((await fetch("/api/providers", { method: "POST", body: "{}" })).status).toBe(200);
  expect((await fetch("/api/models")).status).toBe(200);
  // Settle-once: three requests, one arm probe; nothing prompted, nothing persisted.
  expect(armCalls).toBe(1);
  expect(promptCalls).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(seen).toEqual([
    { path: "/api/config", method: "GET", key: null, origin: "http://localhost", csrf: null },
    { path: "/api/providers", method: "POST", key: null, origin: "http://localhost", csrf: "cookie-csrf" },
    { path: "/api/models", method: "GET", key: null, origin: "http://localhost", csrf: null },
  ]);
});

test("failing cookie arm adds no headers and never prompts by itself", async () => {
  let armCalls = 0;
  const seenOrigins: Array<string | null> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathnameOf(input);
    if (path === "/api/auth/session") {
      armCalls += 1;
      return new Response("unauthorized", { status: 401 });
    }
    if (path === "/opencodex-session") return new Response("unauthorized", { status: 401 });
    seenOrigins.push(headersOf(input, init).get("X-OpenCodex-GUI-Origin"));
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  // Let the arm settle: it must be a pure no-op — no headers armed, no prompt opened.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(armCalls).toBe(1);
  expect(promptCalls).toBe(0);
  expect(seenOrigins).toEqual([]);

  // A real wave still flows through the ordinary resolution path (prompt here returns null).
  expect((await fetch("/api/config")).status).toBe(401);
  expect(seenOrigins).toEqual([null]);
  expect(promptCalls).toBe(1);
});

test("the first /api wave waits for the pending cookie arm instead of racing it", async () => {
  let releaseArm!: () => void;
  let bareRequests = 0;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (pathnameOf(input) === "/api/auth/session") {
      await new Promise<void>((resolve) => {
        releaseArm = resolve;
      });
      return jsonResponse({ csrfToken: "cookie-csrf", origin: "http://localhost", expiresAt: 123 });
    }
    const headers = headersOf(input, init);
    if (!headers.get("X-OpenCodex-GUI-Origin")) bareRequests += 1;
    if (!headers.get("X-OpenCodex-API-Key") && headers.get("X-OpenCodex-GUI-Origin") === "http://localhost") {
      return jsonResponse({});
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  const pending = fetch("/api/config").then((response) => response.status);
  await new Promise((resolve) => setTimeout(resolve, 20));
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);

  releaseArm();
  expect(await pending).toBe(200);
  expect(bareRequests).toBe(0);
  expect(promptCalls).toBe(0);
});

test("an aborted caller unwinds while the cookie arm is still pending", async () => {
  let releaseArm!: () => void;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (pathnameOf(input) === "/api/auth/session") {
      await new Promise<void>((resolve) => {
        releaseArm = resolve;
      });
      return jsonResponse({ csrfToken: "cookie-csrf", origin: "http://localhost", expiresAt: 123 });
    }
    // A real browser rejects an aborted fetch outright; mirror that so the wrapper cannot
    // paper over the race by handing the aborted call to a signal-ignoring mock.
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return jsonResponse({});
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  const controller = new AbortController();
  const pending = fetch("/api/config", { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();

  // Must reject promptly (AbortError), not sit parked until the arm probe settles.
  let rejection: unknown;
  await Promise.race([
    pending.catch((error) => {
      rejection = error;
    }),
    new Promise((resolve) => setTimeout(resolve, 100)).then(() => {
      throw new Error("aborted fetch did not settle while the arm was pending");
    }),
  ]);
  expect(rejection).toBeInstanceOf(DOMException);
  expect((rejection as DOMException).name).toBe("AbortError");

  releaseArm();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(promptCalls).toBe(0);
});

test("admin-token sign-in mints the cookie session best-effort and survives mint failure", async () => {
  const mintCalls: Array<string | null> = [];
  resetApiAuthFetchForTests(async () => {
    promptCalls += 1;
    return "admin-token";
  });
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathnameOf(input);
    const headers = headersOf(input, init);
    if (path === "/api/auth/session") {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        mintCalls.push(headers.get("X-OpenCodex-API-Key"));
        return new Response("mint refused", { status: 403 });
      }
      return new Response("unauthorized", { status: 401 });
    }
    if (path === "/opencodex-session") return new Response("unauthorized", { status: 401 });
    if (headers.get("X-OpenCodex-API-Key") === "admin-token") return jsonResponse({});
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  const response = await fetch("/api/config");
  expect(response.status).toBe(200);
  expect(mintCalls).toEqual(["admin-token"]);
  expect(promptCalls).toBe(1);
});
