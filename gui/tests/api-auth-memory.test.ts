import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installApiAuthFetch, resetApiAuthFetchForTests } from "../src/api";

const LEGACY_TOKEN_KEY = "opencodex-api-token";
const globals = ["document", "window", "navigator", "sessionStorage", "fetch"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let originalPrompt: typeof window.prompt;

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
  originalPrompt = window.prompt;
  resetApiAuthFetchForTests(async () => {
    return window.prompt("OpenCodex admin token (OPENCODEX_ADMIN_AUTH_TOKEN)")?.trim() || null;
  });
  sessionStorage.clear();
});

afterEach(() => {
  window.prompt = originalPrompt;
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
  // installApiAuthFetch replaces window.fetch — keep globalThis in sync for bare `fetch()`.
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });
}

test("installApiAuthFetch deletes legacy sessionStorage token without reading it", () => {
  sessionStorage.setItem(LEGACY_TOKEN_KEY, "legacy-secret");
  let getItemCalls = 0;
  const storage = sessionStorage;
  const originalGetItem = storage.getItem.bind(storage);
  storage.getItem = ((key: string) => {
    getItemCalls += 1;
    return originalGetItem(key);
  }) as typeof storage.getItem;

  try {
    installApiAuthFetch();
    expect(getItemCalls).toBe(0);
    expect(originalGetItem(LEGACY_TOKEN_KEY)).toBeNull();
  } finally {
    storage.getItem = originalGetItem;
  }
});

test("prompted API tokens stay memory-only and are not written to sessionStorage", async () => {
  sessionStorage.setItem(LEGACY_TOKEN_KEY, "legacy-secret");

  let authorized = false;
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("X-OpenCodex-API-Key") === "fresh-token") {
      authorized = true;
      return new Response("{}", { status: 200 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => "fresh-token";

  await installMockAuthFetch(mockFetch);

  const res = await fetch("/api/config");
  expect(res.status).toBe(200);
  expect(authorized).toBe(true);
  expect(sessionStorage.getItem(LEGACY_TOKEN_KEY)).toBeNull();
  expect(sessionStorage.length).toBe(0);
});

test("validates prompted tokens with a safe read before retrying the failed request", async () => {
  const validationResults: string[] = [];
  const seenRequests: Array<[string, string | null]> = [];
  resetApiAuthFetchForTests(async (verifyToken) => {
    validationResults.push(await verifyToken("wrong-token"));
    validationResults.push(await verifyToken("fresh-token"));
    return "fresh-token";
  });

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost/");
    const key = new Headers(init?.headers).get("X-OpenCodex-API-Key");
    seenRequests.push([url.pathname, key]);
    if (url.pathname === "/api/settings" && key === "fresh-token") {
      return new Response("{}", { status: 200 });
    }
    if (url.pathname === "/api/config" && key === "fresh-token") {
      return new Response("{}", { status: 200 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(200);
  expect(validationResults).toEqual(["rejected", "accepted"]);
  expect(seenRequests).toContainEqual(["/api/settings", "wrong-token"]);
  expect(seenRequests).toContainEqual(["/api/settings", "fresh-token"]);
  expect(seenRequests).not.toContainEqual(["/api/config", "wrong-token"]);
  expect(sessionStorage.length).toBe(0);
});

test("cross-origin /api/* requests do not receive the API key or token prompt", async () => {
  let promptCalls = 0;
  let phase: "seed" | "cross" = "seed";
  const seenHeaders: Array<string | null> = [];
  const stateful = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(headers.get("X-OpenCodex-API-Key"));
    if (phase === "seed") {
      if (headers.get("X-OpenCodex-API-Key") === "local-token") return new Response("{}", { status: 200 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "local-token";
  };
  await installMockAuthFetch(stateful);

  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(1);

  phase = "cross";
  const beforeCrossPrompts = promptCalls;
  seenHeaders.length = 0;
  const cross = await fetch("https://evil.example/api/config");
  expect(cross.status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(beforeCrossPrompts);
});

test("concurrent 401s share one token prompt and all retry with the stored token", async () => {
  // Repro for #647: many /api/* requests start without a token (dashboard fan-out).
  // Delivering 401s one-by-one after each auth cycle finishes matches the browser case where
  // window.prompt blocks the main thread: each continuation still holds a captured null token
  // and must reuse the in-memory token from an earlier request instead of prompting again.
  let promptCalls = 0;
  const release401: Array<() => void> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    // Session re-bootstrap probe: this fixture never mints sessions, so fail it fast
    // instead of letting it join the release queue below.
    if (new URL(_input instanceof Request ? _input.url : String(_input), "http://localhost/").pathname === "/opencodex-session") {
      return new Response("unauthorized", { status: 401 });
    }
    if (headers.get("X-OpenCodex-API-Key") === "shared-token") {
      return new Response("{}", { status: 200 });
    }
    await new Promise<void>((resolve) => {
      release401.push(resolve);
    });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "shared-token";
  };
  await installMockAuthFetch(mockFetch);

  const endpoints = [
    "/api/config",
    "/api/providers",
    "/api/models",
    "/api/selected-models",
    "/api/disabled-models",
    "/api/effort-caps",
    "/api/sidecar-settings",
    "/api/injection-model",
    "/api/v2",
    "/api/keys",
    "/api/provider-presets",
    "/api/key-providers",
    "/api/oauth/providers",
    "/api/codex-auth/accounts",
  ];
  const pending = endpoints.map((path) => fetch(path).then((r) => r.status));
  // Let every request reach the 401 gate before any response is delivered.
  for (let i = 0; i < 20 && release401.length < endpoints.length; i += 1) {
    await Promise.resolve();
  }
  expect(release401.length).toBe(endpoints.length);

  for (let i = 0; i < endpoints.length; i += 1) {
    const done = pending[i]!;
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    release401.shift()!();
    for (let spin = 0; spin < 50 && !settled; spin += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
  }

  const statuses = await Promise.all(pending);
  expect(promptCalls).toBe(1);
  expect([...new Set(statuses)]).toEqual([200]);
});

test("stale concurrent 401 does not clear a token refreshed by another request", async () => {
  // Codex/CodeRabbit race: request A prompts and stores T2; request B still holding stale T1
  // must not wipe T2 (clearTokenIfCurrent) before its re-read / shared gate join.
  let promptCalls = 0;
  let acceptV1 = true;
  const release401: Array<() => void> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const key = headers.get("X-OpenCodex-API-Key");
    if (key === "token-v2") return new Response("{}", { status: 200 });
    if (acceptV1 && key === "token-v1") return new Response("{}", { status: 200 });
    if (key === "token-v1") {
      await new Promise<void>((resolve) => {
        release401.push(resolve);
      });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "token-v1";
  };
  await installMockAuthFetch(mockFetch);
  expect((await fetch("/api/config")).status).toBe(200);
  expect(promptCalls).toBe(1);

  acceptV1 = false;
  promptCalls = 0;
  window.prompt = () => {
    promptCalls += 1;
    return "token-v2";
  };

  const pending = [fetch("/api/config"), fetch("/api/providers")].map((p) => p.then((r) => r.status));
  for (let i = 0; i < 20 && release401.length < 2; i += 1) {
    await Promise.resolve();
  }
  expect(release401.length).toBe(2);

  for (let i = 0; i < 2; i += 1) {
    const done = pending[i]!;
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    release401.shift()!();
    for (let spin = 0; spin < 50 && !settled; spin += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
  }

  const statuses = await Promise.all(pending);
  expect(promptCalls).toBe(1);
  expect([...new Set(statuses)]).toEqual([200]);
});

test("canceling the token prompt once does not reopen it for the rest of the 401 fan-out", async () => {
  let promptCalls = 0;
  const release401: Array<() => void> = [];
  const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (new URL(_input instanceof Request ? _input.url : String(_input), "http://localhost/").pathname === "/opencodex-session") {
      return new Response("unauthorized", { status: 401 });
    }
    if (headers.get("X-OpenCodex-API-Key")) {
      return new Response("{}", { status: 200 });
    }
    await new Promise<void>((resolve) => {
      release401.push(resolve);
    });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return null;
  };
  await installMockAuthFetch(mockFetch);

  const endpoints = ["/api/config", "/api/providers", "/api/models", "/api/keys"];
  const pending = endpoints.map((path) => fetch(path).then((r) => r.status));
  for (let i = 0; i < 20 && release401.length < endpoints.length; i += 1) {
    await Promise.resolve();
  }
  expect(release401.length).toBe(endpoints.length);

  for (let i = 0; i < endpoints.length; i += 1) {
    const done = pending[i]!;
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    release401.shift()!();
    for (let spin = 0; spin < 50 && !settled; spin += 1) {
      await Promise.resolve();
    }
    expect(settled).toBe(true);
  }

  const statuses = await Promise.all(pending);
  expect(promptCalls).toBe(1);
  expect([...new Set(statuses)]).toEqual([401]);
});

test("data-plane requests never receive the management token or prompt", async () => {
  let promptCalls = 0;
  let phase: "seed" | "cross" = "seed";
  const seenHeaders: Array<string | null> = [];
  const stateful = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenHeaders.push(headers.get("X-OpenCodex-API-Key"));
    if (phase === "seed") {
      if (headers.get("X-OpenCodex-API-Key") === "local-token") return new Response("{}", { status: 200 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "local-token";
  };
  await installMockAuthFetch(stateful);

  expect((await fetch("/v1/models")).status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(0);

  phase = "cross";
  const beforeCrossPrompts = promptCalls;
  seenHeaders.length = 0;
  const cross = await fetch("https://evil.example/v1/models");
  expect(cross.status).toBe(401);
  expect(seenHeaders).toEqual([null]);
  expect(promptCalls).toBe(beforeCrossPrompts);
});

function injectSessionMeta(token: string, csrf: string, origin: string): void {
  for (const [name, content] of [
    ["opencodex-session-token", token],
    ["opencodex-session-csrf", csrf],
    ["opencodex-session-origin", origin],
  ] as const) {
    const meta = document.createElement("meta");
    meta.setAttribute("name", name);
    meta.setAttribute("content", content);
    document.head.appendChild(meta);
  }
}

function sessionDocumentHtml(token: string, csrf: string, origin: string): string {
  return [
    "<!doctype html><html><head>",
    `<meta name="opencodex-session-token" content="${token}">`,
    `<meta name="opencodex-session-csrf" content="${csrf}">`,
    `<meta name="opencodex-session-origin" content="${origin}">`,
    "</head><body></body></html>",
  ].join("");
}

test("expired session silently re-bootstraps from the served document without prompting", async () => {
  // Regression for the post-security-hardening UX bug: loopback sessions expire after the
  // 5-minute TTL (or die on proxy restart), and the dashboard used to demand an admin token
  // the user never chose. The fetch wrapper must renew the session from a freshly served
  // document instead — token entry is not part of the default loopback experience.
  injectSessionMeta("ocx_session_stale", "stale-csrf", "http://localhost");

  let promptCalls = 0;
  let bootstrapFetches = 0;
  const seenApiKeys: Array<string | null> = [];
  const seenGuiOrigins: Array<string | null> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "http://localhost/");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.pathname === "/opencodex-session") {
      bootstrapFetches += 1;
      return new Response(sessionDocumentHtml("ocx_session_fresh", "fresh-csrf", "http://localhost"), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    seenApiKeys.push(headers.get("X-OpenCodex-API-Key"));
    seenGuiOrigins.push(headers.get("X-OpenCodex-GUI-Origin"));
    if (headers.get("X-OpenCodex-API-Key") === "ocx_session_fresh"
      && headers.get("X-OpenCodex-GUI-Origin") === "http://localhost") {
      return new Response("{}", { status: 200 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return null;
  };
  await installMockAuthFetch(mockFetch);

  const res = await fetch("/api/config");
  expect(res.status).toBe(200);
  expect(promptCalls).toBe(0);
  expect(bootstrapFetches).toBe(1);
  expect(seenApiKeys).toEqual(["ocx_session_stale", "ocx_session_fresh"]);
  expect(seenGuiOrigins).toEqual(["http://localhost", "http://localhost"]);
});

test("a session minted for another origin is rejected and the prompt fallback stays", async () => {
  // Non-loopback dashboards never get server-minted sessions; a re-bootstrap document whose
  // origin does not match must not be trusted, and the operator-only prompt remains.
  let promptCalls = 0;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "http://localhost/");
    const headers = new Headers(init?.headers);
    if (url.pathname === "/opencodex-session") {
      return new Response(sessionDocumentHtml("ocx_session_foreign", "foreign-csrf", "http://192.0.2.10:10100"), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    if (headers.get("X-OpenCodex-API-Key") === "manual-admin-token") return new Response("{}", { status: 200 });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  window.prompt = () => {
    promptCalls += 1;
    return "manual-admin-token";
  };
  await installMockAuthFetch(mockFetch);

  const res = await fetch("/api/config");
  expect(res.status).toBe(200);
  expect(promptCalls).toBe(1);
});
