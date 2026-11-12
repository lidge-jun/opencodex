import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  captureApiTarget,
  configureApiTargets,
  targetFetch,
  TARGET_CHANGED_EVENT,
  TARGET_PREFLIGHT_LEGACY_EVENT,
} from "../src/api";
import { standaloneApiTargets, type ApiTargets } from "../src/api-targets";

const HUB_A = "https://hub-a.example";
const HUB_B = "https://hub-b.example";
const originalFetch = globalThis.fetch;
let win: Window;
let previous: Record<string, unknown>;

function relayTargets(origin: string, relayTargetCheck?: "expected-target-v1"): ApiTargets {
  const base = standaloneApiTargets("");
  return {
    ...base,
    connected: true,
    machine: { ...base.machine, baseUrl: "" },
    shared: { ...base.shared, baseUrl: "/api/machine/hub-relay", serverOrigin: origin, transport: "relay" },
    apiKeyId: "fixture-key",
    ...(relayTargetCheck ? { relayTargetCheck } : {}),
  };
}

function mutation(path = "/api/machine/hub-relay/api/providers?name=p"): Promise<Response> {
  return targetFetch(captureApiTarget("shared"), path, { method: "PATCH", body: "{}" });
}

beforeEach(() => {
  previous = Object.fromEntries(["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://127.0.0.1:4800/" });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  win.close();
  for (const [key, value] of Object.entries(previous)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

test("a captured target refuses before fetch after a target change and across A-B-A", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return Response.json({ ok: true }); }) as typeof fetch;
  configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
  const capture = captureApiTarget("shared");
  configureApiTargets(relayTargets(HUB_B, "expected-target-v1"));
  expect((await targetFetch(capture, "/api/machine/hub-relay/api/providers?name=p", { method: "PATCH" })).status).toBe(409);
  configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
  expect((await targetFetch(capture, "/api/machine/hub-relay/api/providers?name=p", { method: "PATCH" })).status).toBe(409);
  expect(calls).toBe(0);
});

test("a same-target refresh keeps the request generation and sends the captured header", async () => {
  const seen: Array<{ url: string; expected: string | null }> = [];
  globalThis.fetch = (async (input, init) => {
    seen.push({ url: String(input), expected: new Headers(init?.headers).get("x-opencodex-expected-target") });
    return Response.json({ ok: true });
  }) as typeof fetch;
  configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
  const capture = captureApiTarget("shared");
  configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
  // The capture taken before the same-target refresh is still current: the refresh
  // keeps the generation, so the header it carries is the one the mutation sends.
  expect((await targetFetch(capture, "/api/machine/hub-relay/api/providers?name=p", { method: "PATCH", body: "{}" })).status).toBe(200);
  expect(seen).toEqual([{ url: "/api/machine/hub-relay/api/providers?name=p", expected: HUB_A }]);
});

test("a captured target cannot authorize a different destination URL", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return Response.json({ ok: true }); }) as typeof fetch;
  configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
  const capture = captureApiTarget("shared");
  expect((await targetFetch(capture, "https://hub-b.example/api/providers", { method: "PATCH" })).status).toBe(409);
  expect(calls).toBe(0);
});

test("a legacy relay mismatch or unavailable status sends no mutation", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return Response.json({ sharedServerOrigin: HUB_B });
  }) as typeof fetch;
  configureApiTargets(relayTargets(HUB_A));
  expect((await mutation()).status).toBe(409);
  expect(calls).toEqual(["/api/machine/status"]);

  calls.length = 0;
  globalThis.fetch = (async (input) => { calls.push(String(input)); throw new Error("offline"); }) as typeof fetch;
  configureApiTargets(relayTargets(HUB_A));
  expect((await mutation()).status).toBe(503);
  expect(calls).toEqual(["/api/machine/status"]);
});

test("a matching legacy preflight sends the mutation and emits one scoped notice", async () => {
  const calls: string[] = [];
  const notices: Array<{ targetKey?: string }> = [];
  const onNotice = (event: Event) => notices.push((event as CustomEvent<{ targetKey?: string }>).detail);
  win.addEventListener(TARGET_PREFLIGHT_LEGACY_EVENT, onNotice);
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    if (String(input) === "/api/machine/status") return Response.json({ sharedServerOrigin: HUB_A });
    return Response.json({ ok: true });
  }) as typeof fetch;
  configureApiTargets(relayTargets(HUB_A));
  expect((await mutation()).status).toBe(200);
  expect(calls).toEqual(["/api/machine/status", "/api/machine/hub-relay/api/providers?name=p"]);
  expect(notices).toHaveLength(1);
  expect(notices[0]?.targetKey).toBe(HUB_A);
  win.removeEventListener(TARGET_PREFLIGHT_LEGACY_EVENT, onNotice);
});

test("a relay 409 target_changed requests rediscovery", async () => {
  let changed = 0;
  const onChange = () => { changed += 1; };
  win.addEventListener(TARGET_CHANGED_EVENT, onChange);
  globalThis.fetch = (async () => Response.json({ error: "target_changed" }, { status: 409 })) as typeof fetch;
  configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
  expect((await mutation()).status).toBe(409);
  expect(changed).toBe(1);
  win.removeEventListener(TARGET_CHANGED_EVENT, onChange);
});

test("a standalone embedded base is authoritative only before discovery", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return Response.json({ ok: true });
  }) as typeof fetch;
  configureApiTargets(standaloneApiTargets(""));
  const capture = captureApiTarget("shared", "http://embedded.example");
  expect(capture).toMatchObject({
    apiBase: "http://embedded.example",
    origin: "http://embedded.example",
    transport: "same-origin",
    standalone: true,
  });
  expect((await targetFetch(capture, "http://embedded.example/api/providers", { method: "POST", body: "{}" })).status).toBe(200);
  // The capture still bounds the destination: another origin is refused.
  expect((await targetFetch(capture, "http://other.example/api/providers", { method: "POST", body: "{}" })).status).toBe(409);
  // Once discovery configures a connected plane, the embedded base is no longer the target.
  configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
  expect((await targetFetch(capture, "http://embedded.example/api/providers", { method: "POST", body: "{}" })).status).toBe(409);
  expect(calls).toEqual(["http://embedded.example/api/providers"]);
});

test("a configured relay ignores a caller-supplied base", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input) => {
    seen.push(String(input));
    return Response.json({ ok: true });
  }) as typeof fetch;
  configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
  const capture = captureApiTarget("shared", "https://evil.example");
  expect(capture.apiBase).toBe("/api/machine/hub-relay");
  expect(capture.origin).toBe(HUB_A);
  expect(capture.standalone).toBeUndefined();
  expect((await targetFetch(capture, "https://evil.example/api/providers", { method: "PATCH" })).status).toBe(409);
  expect(seen).toEqual([]);
});

test("a 401 retry keeps the captured expected target on both attempts", async () => {
  const { installApiAuthFetch, installApiSessionFromHtml, resetApiAuthFetchForTests } = await import("../src/api");
  const sessionHtml = (token: string) => [
    "<!doctype html><html><head>",
    `<meta name="opencodex-session-token" content="${token}">`,
    `<meta name="opencodex-session-csrf" content="${token}-csrf">`,
    '<meta name="opencodex-session-origin" content="http://127.0.0.1:4800">',
    `<meta name="opencodex-session-server-origin" content="${HUB_A}">`,
    "</head><body></body></html>",
  ].join("");
  const attempts: Array<{ expected: string | null; key: string | null }> = [];
  let minted = 0;
  const raw = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://127.0.0.1:4800/");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.pathname.endsWith("/opencodex-session")) {
      minted += 1;
      return new Response(sessionHtml("ocx_session_fresh"), { status: 200, headers: { "Content-Type": "text/html" } });
    }
    attempts.push({ expected: headers.get("x-opencodex-expected-target"), key: headers.get("x-opencodex-api-key") });
    if (attempts.length === 1) return new Response("unauthorized", { status: 401 });
    return Response.json({ ok: true });
  }) as typeof fetch;
  Object.defineProperty(win, "fetch", { configurable: true, writable: true, value: raw });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: raw });
  try {
    resetApiAuthFetchForTests();
    configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
    installApiAuthFetch();
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: win.fetch });
    expect(installApiSessionFromHtml("shared", sessionHtml("ocx_session_old"))).toBe(true);
    const capture = captureApiTarget("shared");
    const response = await targetFetch(capture, "/api/machine/hub-relay/api/providers?name=p", { method: "PATCH", body: "{}" });
    expect(response.status).toBe(200);
    expect(attempts).toHaveLength(2);
    // The retry re-reads authentication but never re-derives the expected target.
    expect(attempts[0]).toEqual({ expected: HUB_A, key: "ocx_session_old" });
    expect(attempts[1]).toEqual({ expected: HUB_A, key: "ocx_session_fresh" });
    expect(minted).toBe(1);
  } finally {
    resetApiAuthFetchForTests();
  }
});

test("a same-identity capability downgrade uses the fresh legacy preflight", async () => {
  const seen: Array<{ url: string; expected: string | null }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/machine/status") return Response.json({ sharedServerOrigin: HUB_A });
    seen.push({ url, expected: new Headers(init?.headers).get("x-opencodex-expected-target") });
    return Response.json({ ok: true });
  }) as typeof fetch;
  configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
  const capture = captureApiTarget("shared");
  // Same identity, capability withdrawn: the old capture must not vouch for the header.
  configureApiTargets(relayTargets(HUB_A));
  expect((await targetFetch(capture, "/api/machine/hub-relay/api/providers?name=p", { method: "PATCH", body: "{}" })).status).toBe(200);
  expect(seen).toEqual([{ url: "/api/machine/hub-relay/api/providers?name=p", expected: null }]);
});

test("a target change with a capability downgrade refuses before fetch", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return Response.json({ ok: true }); }) as typeof fetch;
  configureApiTargets(relayTargets(HUB_A, "expected-target-v1"));
  const capture = captureApiTarget("shared");
  configureApiTargets(relayTargets(HUB_B));
  expect((await targetFetch(capture, "/api/machine/hub-relay/api/providers?name=p", { method: "PATCH", body: "{}" })).status).toBe(409);
  expect(calls).toBe(0);
});
