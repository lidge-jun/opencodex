import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  installApiAuthFetch,
  resetApiAuthFetchForTests,
  setRebootstrapTimeoutForTests,
  setResolutionWatchdogForTests,
} from "../src/api";

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
  setRebootstrapTimeoutForTests(10_000);
  setResolutionWatchdogForTests(15_000);
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

function sessionDocumentHtml(token: string, csrf: string, origin: string): string {
  return [
    "<!doctype html><html><head>",
    `<meta name="opencodex-session-token" content="${token}">`,
    `<meta name="opencodex-session-csrf" content="${csrf}">`,
    `<meta name="opencodex-session-origin" content="${origin}">`,
    "</head><body></body></html>",
  ].join("");
}

function pathnameOf(input: RequestInfo | URL): string {
  return new URL(input instanceof Request ? input.url : String(input), "http://localhost/").pathname;
}

/** A hang that honors the abort signal, like real fetch does. */
function hangUntilAborted(signal?: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

const MINTED = () => new Response(sessionDocumentHtml("ocx_session_fresh", "fresh-csrf", "http://localhost"), {
  status: 200,
  headers: { "Content-Type": "text/html" },
});
test("hung bootstrap fails the wave within the deadline and a later wave re-bootstraps to success", async () => {
  setRebootstrapTimeoutForTests(50);
  let bootstrapCalls = 0;
  let bootstrapHangs = true;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = pathnameOf(input);
    if (path === "/opencodex-session") {
      bootstrapCalls += 1;
      if (bootstrapHangs) return hangUntilAborted(init?.signal);
      return MINTED();
    }
    const key = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("X-OpenCodex-API-Key");
    if (key === "ocx_session_fresh") return new Response("{}", { status: 200 });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  // Wave 1: bootstrap hangs -> deadline -> wave settles with the original 401.
  const first = await fetch("/api/config");
  expect(first.status).toBe(401);
  expect(bootstrapCalls).toBe(1);
  expect(promptCalls).toBe(0);

  // Wave 2: resolutionInFlight cleared — a fresh bootstrap runs and mints.
  bootstrapHangs = false;
  const second = await fetch("/api/config");
  expect(second.status).toBe(200);
  expect(bootstrapCalls).toBe(2);

  // Wave 3: a valid session token means no further bootstrap at all.
  const third = await fetch("/api/config");
  expect(third.status).toBe(200);
  expect(bootstrapCalls).toBe(2);
});

test("bootstrap timeout and 5xx never open the admin-token prompt; only refusal does", async () => {
  setRebootstrapTimeoutForTests(40);
  let mode: "hang" | "bad-gateway" | "refuse" = "hang";
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (pathnameOf(input) === "/opencodex-session") {
      if (mode === "hang") return hangUntilAborted(init?.signal ?? (input instanceof Request ? input.signal : undefined));
      if (mode === "bad-gateway") return new Response("bad gateway", { status: 502 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  expect((await fetch("/api/config")).status).toBe(401);   // timeout path
  mode = "bad-gateway";
  expect((await fetch("/api/config")).status).toBe(401);   // 5xx path
  expect(promptCalls).toBe(0);

  mode = "refuse";                                          // definitive 4xx -> prompt fallback
  expect((await fetch("/api/config")).status).toBe(401);
  expect(promptCalls).toBe(1);
});

test("caller abort during a pending resolution unwinds only that caller", async () => {
  setRebootstrapTimeoutForTests(5_000);
  let releaseBootstrap: (() => void) | null = null;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (pathnameOf(input) === "/opencodex-session") {
      return new Promise<Response>((resolve) => {
        releaseBootstrap = () => resolve(MINTED());
      });
    }
    const key = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("X-OpenCodex-API-Key");
    if (key === "ocx_session_fresh") return new Response("{}", { status: 200 });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  const controllerA = new AbortController();
  let adds = 0;
  let removes = 0;
  const origAdd = controllerA.signal.addEventListener.bind(controllerA.signal);
  const origRemove = controllerA.signal.removeEventListener.bind(controllerA.signal);
  controllerA.signal.addEventListener = ((...args: unknown[]) => { adds += 1; return (origAdd as (...a: unknown[]) => void)(...args); }) as typeof controllerA.signal.addEventListener;
  controllerA.signal.removeEventListener = ((...args: unknown[]) => { removes += 1; return (origRemove as (...a: unknown[]) => void)(...args); }) as typeof controllerA.signal.removeEventListener;

  const a = fetch("/api/config", { signal: controllerA.signal });
  const b = fetch("/api/providers");
  // Both wait on the same pending bootstrap; abort A only.
  await new Promise((resolve) => setTimeout(resolve, 30));
  controllerA.abort();
  const resA = await a;
  expect(resA.status).toBe(401);

  let bSettled = false;
  void b.then(() => { bSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(bSettled).toBe(false);

  releaseBootstrap!();
  const resB = await b;
  expect(resB.status).toBe(200);
  // The race listener on A's signal is removed whether the race wins or loses.
  expect(adds).toBeGreaterThan(0);
  expect(removes).toBe(adds);
});

test("the retried request carries the caller signal", async () => {
  setRebootstrapTimeoutForTests(1_000);
  const seenSignals: Array<AbortSignal | null | undefined> = [];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (pathnameOf(input) === "/opencodex-session") return MINTED();
    seenSignals.push(init?.signal ?? (input instanceof Request ? input.signal : undefined));
    const key = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("X-OpenCodex-API-Key");
    if (key === "ocx_session_fresh") return new Response("{}", { status: 200 });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  const controller = new AbortController();
  const res = await fetch("/api/config", { signal: controller.signal });
  expect(res.status).toBe(200);
  // First attempt + retry, both carrying the caller's signal.
  expect(seenSignals.length).toBe(2);
  expect(seenSignals[1]).toBe(controller.signal);
});
test("a signal-dropping hung bootstrap is bounded by the whole-resolution watchdog", async () => {
  // The bootstrap bound alone relies on fetch honoring the abort; a fetch that
  // ignores it would otherwise pin the shared resolution (and every /api waiter)
  // for the page lifetime. The watchdog must unwrap the wave and let the next one
  // start a FRESH resolution.
  setRebootstrapTimeoutForTests(50);
  setResolutionWatchdogForTests(300);
  let bootstrapCalls = 0;
  let bootstrapZombie = true;
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (pathnameOf(input) === "/opencodex-session") {
      bootstrapCalls += 1;
      // Zombie: never settles AND ignores the abort signal.
      if (bootstrapZombie) return new Promise<Response>(() => {});
      return MINTED();
    }
    const key = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("X-OpenCodex-API-Key");
    if (key === "ocx_session_fresh") return new Response("{}", { status: 200 });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  const first = await fetch("/api/config");
  expect(first.status).toBe(401);
  expect(bootstrapCalls).toBe(1);
  expect(promptCalls).toBe(0);

  bootstrapZombie = false;
  const second = await fetch("/api/config");
  expect(second.status).toBe(200);
  expect(bootstrapCalls).toBe(2);
});
test("the watchdog never bounds the prompt: slow user input stacks no dialogs and waves join", async () => {
  // Non-loopback shape: the bootstrap definitively refuses (401 -> unavailable), so
  // resolution escalates to the prompt. The prompt is user-controlled: the watchdog
  // must NOT fire around it, and later 401 waves must join the pending body instead
  // of opening another dialog (promptForAdminToken has no singleton guard).
  setRebootstrapTimeoutForTests(50);
  setResolutionWatchdogForTests(120);
  let bootstrapCalls = 0;
  let releasePrompt: ((token: string) => void) | null = null;
  resetApiAuthFetchForTests(async () => {
    promptCalls += 1;
    return new Promise<string>((resolve) => {
      releasePrompt = resolve;
    });
  });
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (pathnameOf(input) === "/opencodex-session") {
      bootstrapCalls += 1;
      return new Response("unauthorized", { status: 401 });
    }
    const key = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("X-OpenCodex-API-Key");
    if (key === "manual-admin-token") return new Response("{}", { status: 200 });
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  await installMockAuthFetch(mockFetch);

  const a = fetch("/api/config");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const b = fetch("/api/providers");
  // Sit past the watchdog window: the pending prompt must hold both waves.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(promptCalls).toBe(1);
  expect(bootstrapCalls).toBe(1);

  releasePrompt!("manual-admin-token");
  const [resA, resB] = await Promise.all([a, b]);
  expect(resA.status).toBe(200);
  expect(resB.status).toBe(200);
  expect(promptCalls).toBe(1);
});
