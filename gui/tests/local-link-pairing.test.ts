import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { configureApiTargets, fetchApiSessionValidation, installApiAuthFetch, installApiSessionFromHtml, resetApiAuthFetchForTests } from "../src/api";
import type { ApiTargets } from "../src/api-targets";
import { PairingError, setPairingDeadlineForTests, submitConnectPairing, validateRemoteLinkSession } from "../src/connect-pairing-transport";

const origin = "http://127.0.0.1:10100";
function sessionHtml(token: string, serverOrigin = origin): string {
  return `<meta name="opencodex-session-token" content="${token}"><meta name="opencodex-session-csrf" content="${token}-csrf"><meta name="opencodex-session-origin" content="${origin}"><meta name="opencodex-session-server-origin" content="${serverOrigin}">`;
}

// TRANSPORT_REGRESSIONS_BEGIN
for (const relay of [false, true]) test(`pairing omits stale shared authentication and preserves the machine boundary (relay: ${relay})`, async () => {
  const keys = ["window", "document", "sessionStorage"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new Window({ url: origin });
  const sent: Headers[] = [];
  const rawFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win }, document: { configurable: true, value: win.document },
    sessionStorage: { configurable: true, value: win.sessionStorage },
  });
  Object.defineProperty(win, "fetch", { configurable: true, value: rawFetch, writable: true });
  const targets: ApiTargets = { connected: relay,
    machine: { id: "machine", baseUrl: "", serverOrigin: origin, bootstrapPath: "/opencodex-session", transport: "same-origin" },
    shared: { id: "shared", baseUrl: relay ? "/api/machine/hub-relay" : "", serverOrigin: relay ? "https://hub.example.test" : origin,
      bootstrapPath: relay ? "/api/machine/hub-relay/opencodex-session" : "/opencodex-session", transport: relay ? "relay" : "same-origin" },
  };
  try {
    resetApiAuthFetchForTests(); configureApiTargets(targets); installApiAuthFetch();
    expect(installApiSessionFromHtml("machine", sessionHtml("ocx_session_machine"))).toBe(true);
    expect(installApiSessionFromHtml("shared", sessionHtml("ocx_session_old", targets.shared.serverOrigin))).toBe(true);
    await win.fetch(targets.shared.bootstrapPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant: `ocx_pair_${"a".repeat(43)}` }) });
    expect(sent[0]!.get("x-opencodex-api-key")).toBeNull();
    expect(sent[0]!.get("x-opencodex-gui-origin")).toBeNull();
    expect(sent[0]!.get("x-opencodex-csrf-token")).toBeNull();
    expect(sent[0]!.get("x-opencodex-machine-session")).toBe(relay ? "ocx_session_machine" : null);
    expect(sent[0]!.get("x-opencodex-machine-csrf-token")).toBe(relay ? "ocx_session_machine-csrf" : null);
    await win.fetch(`${targets.shared.baseUrl}/api/link/join`, { method: "POST" });
    expect(sent[1]!.get("x-opencodex-api-key")).toBe("ocx_session_old");
    expect(sent[1]!.get("x-opencodex-csrf-token")).toBe("ocx_session_old-csrf");
    // Explicit mixed credentials are not silently stripped: the server still refuses them.
    await win.fetch(targets.shared.bootstrapPath, { method: "POST", headers: { authorization: "Bearer explicit" } });
    expect(sent[2]!.get("authorization")).toBe("Bearer explicit");
    // A successful exchange installs the returned session without reloading into an unpaired bootstrap.
    expect(installApiSessionFromHtml("shared", sessionHtml("ocx_session_paired", targets.shared.serverOrigin))).toBe(true);
    await win.fetch(`${targets.shared.baseUrl}/api/link/status`);
    expect(sent[3]!.get("x-opencodex-api-key")).toBe("ocx_session_paired");
  } finally {
    resetApiAuthFetchForTests(); win.close();
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
// TRANSPORT_REGRESSIONS_END

test("desktop pairing replaces only the machine session and subsequent desktop mutations use it", async () => {
  const keys = ["window", "document", "sessionStorage"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new Window({ url: origin }), sent: { path: string; headers: Headers }[] = [];
  const targets: ApiTargets = { connected: false,
    machine: { id: "machine", baseUrl: "", serverOrigin: origin, bootstrapPath: "/opencodex-session", transport: "same-origin" },
    shared: { id: "shared", baseUrl: "", serverOrigin: origin, bootstrapPath: "/opencodex-session", transport: "same-origin" } };
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(win, key === "window" ? "self" : key) });
  Object.defineProperty(win, "fetch", { configurable: true, writable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ path: String(input), headers: new Headers(init?.headers) });
    return String(input).endsWith("/opencodex-session") ? new Response(sessionHtml("ocx_session_paired")) : new Response(null, { status: 204 });
  } });
  try {
    resetApiAuthFetchForTests(); configureApiTargets(targets); installApiAuthFetch();
    expect(installApiSessionFromHtml("machine", sessionHtml("ocx_session_automatic"))).toBe(true);
    expect(installApiSessionFromHtml("shared", sessionHtml("ocx_session_shared"))).toBe(true);
    const handoff = await submitConnectPairing(targets.machine, `ocx_pair_${"a".repeat(43)}`);
    await fetchApiSessionValidation("machine", "/api/codex/desktop-compatibility/certificate", {});
    expect(sent.at(-1)!.headers.get("x-opencodex-api-key")).toBe("ocx_session_paired");
    handoff.commit();
    await win.fetch("/api/codex/desktop-compatibility/runtime", { method: "POST" });
    expect(sent.at(-1)!.headers.get("x-opencodex-api-key")).toBe("ocx_session_paired");
    expect(sent.at(-1)!.headers.get("x-opencodex-csrf-token")).toBe("ocx_session_paired-csrf");
    await win.fetch("/api/status");
    expect(sent.at(-1)!.headers.get("x-opencodex-api-key")).toBe("ocx_session_shared");
    expect(sent[0]!.headers.has("x-opencodex-api-key")).toBe(false);
  } finally {
    resetApiAuthFetchForTests(); win.close();
    for (const key of keys) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test("local pairing form names the local origin, makes no automatic exchange, and waits for explicit submission", async () => {
  const keys = ["window", "document", "navigator", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new Window({ url: origin });
  let requests = 0;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win }, document: { configurable: true, value: win.document },
    navigator: { configurable: true, value: win.navigator }, sessionStorage: { configurable: true, value: win.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  Object.defineProperty(win, "fetch", { configurable: true, value: async () => { requests++; return new Response(null, { status: 403 }); } });
  const container = document.createElement("div"); document.body.append(container);
  const { LanguageProvider } = await import("../src/i18n/provider");
  const { ConnectPairingForm } = await import("../src/connect-pairing");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(LanguageProvider, null, createElement(ConnectPairingForm, {
      local: true, target: { id: "shared", baseUrl: "", serverOrigin: origin, bootstrapPath: "/opencodex-session", transport: "same-origin" },
      onConnected: () => { throw new Error("unexpected success"); },
    }))));
    expect(container.textContent).toContain(`ocx gui pair --origin "${origin}"`);
    expect(container.textContent).not.toContain("Connect this dashboard to the hub");
    expect(requests).toBe(0);
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    const input = container.querySelector("#connect-pairing-code") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, `ocx_pair_${"a".repeat(43)}`);
    await act(async () => { input.dispatchEvent(new win.Event("input", { bubbles: true })); });
    await act(async () => { input.closest("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); });
    expect(requests).toBe(1);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount()); container.remove(); win.close();
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test.each([401, 403])("a stalled refusal-body cleanup still surfaces the pairing exchange refusal immediately (status: %s)", async status => {
  const keys = ["window", "document", "sessionStorage"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new Window({ url: origin }), sent: { path: string; headers: Headers }[] = [];
  const targets: ApiTargets = { connected: false,
    machine: { id: "machine", baseUrl: "", serverOrigin: origin, bootstrapPath: "/opencodex-session", transport: "same-origin" },
    shared: { id: "shared", baseUrl: "", serverOrigin: origin, bootstrapPath: "/opencodex-session", transport: "same-origin" } };
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(win, key === "window" ? "self" : key) });
  Object.defineProperty(win, "fetch", { configurable: true, writable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ path: String(input), headers: new Headers(init?.headers) });
    return new Response(null, { status: 204 });
  } });
  let releaseStall: (() => void) | undefined, cancelCalls = 0;
  const refused = new Response(null, { status });
  Object.defineProperty(refused, "body", { value: { cancel: () => { cancelCalls++; return new Promise<void>(resolve => { releaseStall = () => resolve(); }); } } });
  try {
    setPairingDeadlineForTests(100);
    resetApiAuthFetchForTests(); configureApiTargets(targets); installApiAuthFetch();
    expect(installApiSessionFromHtml("machine", sessionHtml("ocx_session_automatic"))).toBe(true);
    expect(installApiSessionFromHtml("shared", sessionHtml("ocx_session_shared"))).toBe(true);
    const failure = await submitConnectPairing(targets.machine, `ocx_pair_${"a".repeat(43)}`, (async () => refused) as typeof fetch)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(PairingError);
    expect((failure as PairingError).kind).toBe(status === 401 ? "refused" : "origin-denied");
    expect(cancelCalls).toBe(1);
    await win.fetch("/api/codex/desktop-compatibility/certificate");
    expect(sent.at(-1)!.headers.get("x-opencodex-api-key")).toBe("ocx_session_automatic");
  } finally {
    releaseStall?.(); setPairingDeadlineForTests(10_000);
    resetApiAuthFetchForTests(); win.close();
    for (const key of keys) { const descriptor = previous[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test.each([401, 403])("a stalled refusal-body cleanup keeps remote-link validation definitive (status: %s)", async status => {
  let releaseStall: (() => void) | undefined, cancelCalls = 0;
  const refused = new Response(null, { status });
  Object.defineProperty(refused, "body", { value: { cancel: () => { cancelCalls++; return new Promise<void>(resolve => { releaseStall = () => resolve(); }); } } });
  try {
    setPairingDeadlineForTests(100);
    const failure = await validateRemoteLinkSession("", (async () => refused) as typeof fetch)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(PairingError);
    expect((failure as PairingError).kind).toBe(status === 401 ? "remote-link-unauthorized" : "remote-link-forbidden");
    expect(cancelCalls).toBe(1);
  } finally { releaseStall?.(); setPairingDeadlineForTests(10_000); }
});

test.each([false, true])("HTML prefix classification survives stalled reader cleanup (challenge: %s)", async challenge => {
  let cancelCalls = 0, release: (() => void) | undefined;
  const response = new Response(null, { status: 401, headers: { "Content-Type": "text/html" } });
  const text = (challenge ? "<title>Just a moment...</title>" : "<title>Unauthorized</title>").padEnd(16 * 1024, " ");
  Object.defineProperty(response, "body", { value: {
    getReader: () => ({
      read: async () => ({ done: false, value: new TextEncoder().encode(text) }),
      cancel: () => { cancelCalls++; return new Promise<void>(resolve => { release = resolve; }); },
    }),
    cancel: async () => {},
  } });
  try {
    setPairingDeadlineForTests(100);
    const error = await validateRemoteLinkSession("", (async () => response) as typeof fetch).then(() => null, error => error);
    expect(error).toBeInstanceOf(PairingError);
    expect((error as PairingError).kind).toBe(challenge ? "cloudflare-challenge" : "remote-link-unauthorized");
    expect(cancelCalls).toBe(1);
  } finally { release?.(); setPairingDeadlineForTests(10_000); }
});
