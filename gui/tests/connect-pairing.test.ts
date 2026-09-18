import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

test("App mounts the relay pairing form and installs only the returned shared session", async () => {
  const keys = ["window", "document", "navigator", "sessionStorage", "localStorage", "fetch", "confirm", "alert", "IS_REACT_ACT_ENVIRONMENT", "__APP_VERSION__"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  const win = new Window({ url: "http://localhost/#dashboard" });
  // Hidden documents have no periodic resource poll: pairing must explicitly revalidate.
  Object.defineProperty(win.document, "visibilityState", { configurable: true, value: "hidden" });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win },
    document: { configurable: true, value: win.document },
    navigator: { configurable: true, value: win.navigator },
    sessionStorage: { configurable: true, value: win.sessionStorage },
    localStorage: { configurable: true, value: win.localStorage },
    confirm: { configurable: true, value: () => true },
    alert: { configurable: true, value: () => {} },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    __APP_VERSION__: { configurable: true, value: "0.0.0-test" },
  });
  for (const [name, content] of [
    ["opencodex-session-token", "ocx_session_machine"],
    ["opencodex-session-csrf", "machine-csrf"],
    ["opencodex-session-origin", "http://localhost"],
    ["opencodex-session-server-origin", "http://localhost"],
    // The server states the role in the served document. Without it this reads as
    // standalone, discovery never runs, and the relay pairing form never mounts — which
    // is exactly the behavior a plain install should get.
    ["opencodex-runtime-role", "client"],
  ]) {
    const meta = document.createElement("meta");
    meta.name = name;
    meta.content = content;
    document.head.append(meta);
  }

  let authorized = false;
  let rejectSession = false;
  let authenticatedHealthReads = 0;
  let pairingRequest: { method: string; body: string; headers: Headers } | null = null;
  const sessionHtml = [
    '<meta name="opencodex-session-token" content="ocx_session_hub">',
    '<meta name="opencodex-session-csrf" content="hub-csrf">',
    '<meta name="opencodex-session-origin" content="http://localhost">',
    '<meta name="opencodex-session-server-origin" content="https://hub.example.test">',
  ].join("");
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost/");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.pathname === "/api/machine/status") return Response.json({
      mode: "client", connected: true, machineBase: "http://localhost",
      sharedBase: "http://localhost/api/machine/hub-relay",
      sharedServerOrigin: "https://hub.example.test", managementTransport: "relay",
      apiKeyId: "client-key-a", protocolVersion: 1, connectedAt: "2026-08-28T00:00:00.000Z",
      hubReachability: "unknown",
    });
    if (url.pathname === "/api/machine/hub-relay/opencodex-session" && init?.method === "POST") {
      authorized = true; rejectSession = false;
      pairingRequest = { method: init.method, body: String(init.body), headers };
      return new Response(sessionHtml, { headers: { "Content-Type": "text/html" } });
    }
    if (url.pathname.endsWith("/opencodex-session")) return new Response(null, { status: 401 });
    if (url.pathname.endsWith("/api/system/health")) {
      if (!authorized || rejectSession) return new Response(null, { status: 401 });
      expect(headers.get("x-opencodex-api-key")).toBe("ocx_session_hub");
      authenticatedHealthReads++;
      return Response.json({ status: "ok", version: "0.0.0-test", uptime: 30 });
    }
    if (url.pathname.endsWith("/api/providers")) return Response.json([
      { name: "fixture", adapter: "openai-chat", baseUrl: "https://fixture.example.test", hasApiKey: false },
    ]);
    if (url.pathname.endsWith("/api/models")) return Response.json([]);
    if (url.pathname === "/healthz") return Response.json({ version: "0.0.0-test" });
    if (url.pathname.endsWith("/api/sidecar-settings")) return Response.json({
      webSearch: { model: "gpt-5.6-luna" },
      vision: { model: "gpt-5.6-luna", enabled: true },
    });
    if (url.pathname.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "gpt-5.6-luna" });
    if (url.pathname.endsWith("/api/usage")) return Response.json({
      range: "30d", surface: "all", since: null, generatedAt: Date.now(),
      summary: { requests: 0, attemptCount: 0, measuredRequests: 0, reportedRequests: 0, unreportedRequests: 0, unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, coverageRatio: 0, estimatedCostUsd: 0, pricedRequests: 0, unpricedRequests: 0, unmeteredRequests: 0 },
      days: [], models: [], providers: [], accounts: [], historyTruncated: false,
    });
    return Response.json({});
  }) as typeof fetch;
  Object.defineProperties(globalThis, {
    fetch: { configurable: true, value: mockFetch },
  });
  Object.defineProperty(win, "fetch", { configurable: true, value: mockFetch });

  const container = document.createElement("div");
  document.body.append(container);
  const { LanguageProvider } = await import("../src/i18n/provider");
  // Bind the auth-fetch wrapper to THIS window before App mounts.
  //
  // App calls installApiAuthFetch() at module scope, so it runs on first import only. A
  // later test importing App gets the cached module and no install, leaving the wrapper
  // bound to whichever window imported it first. The relayed pairing request then goes out
  // unwrapped — no machine-session headers, which is exactly what this test asserts.
  // Standalone the ordering happens to work; in the full suite it does not. Re-binding here
  // makes the test independent of import order rather than of any product behavior.
  const { resetApiAuthFetchForTests, installApiAuthFetch, configureApiTargets } = await import("../src/api");
  const { standaloneApiTargets } = await import("../src/api-targets");
  resetApiAuthFetchForTests();
  configureApiTargets(standaloneApiTargets(""));
  installApiAuthFetch();
  const { default: App } = await import("../src/App");
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: win.fetch });
  const resources = await import("../src/client-resource");
  resources.clearClientResourceStoresForTests();
  resources.setClientResourceData("dashboard-overview:http://localhost/api/machine/hub-relay", {
    health: null, providers: [], error: true, failure: "auth",
  });
  const sidecarFixture = {
    sidecar: {
      webSearch: { model: "gpt-5.6-luna" },
      vision: { model: "gpt-5.6-luna", enabled: true },
    },
    shadowCall: null,
  };
  resources.setClientResourceData("dashboard-sidecars:http://localhost/api/machine/hub-relay", sidecarFixture);
  resources.setClientResourceData("dashboard-sidecars:", sidecarFixture);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(LanguageProvider, null, createElement(App))); });
    const deadline = Date.now() + 1_000;
    while (!container.querySelector("#connect-pairing-code")) {
      if (Date.now() >= deadline) throw new Error("pairing form did not mount from App");
      await act(async () => { await new Promise(resolve => win.setTimeout(resolve, 10)); });
    }
    expect(container.textContent).toContain("https://hub.example.test");
    expect(container.textContent).toContain('ocx gui pair --origin "http://localhost"');
    expect(container.textContent).not.toContain("ocx start");
    expect(container.querySelector(".dashboard-workspace-shell")).toBeNull();
    const input = container.querySelector("#connect-pairing-code") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, `ocx_pair_${"a".repeat(43)}`);
    await act(async () => { input.dispatchEvent(new win.Event("input", { bubbles: true })); });
    const form = input.closest("form")!;
    await act(async () => { form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); });
    const successDeadline = Date.now() + 1_000;
    while (container.querySelector("#connect-pairing-code")) {
      if (Date.now() >= successDeadline) throw new Error("pairing form did not hide after success");
      await act(async () => { await Promise.resolve(); });
    }
    expect(pairingRequest?.method).toBe("POST");
    expect(pairingRequest?.body).toBe(JSON.stringify({ grant: `ocx_pair_${"a".repeat(43)}` }));
    expect(pairingRequest?.headers.get("x-opencodex-machine-session")).toBe("ocx_session_machine");
    expect(pairingRequest?.headers.get("x-opencodex-api-key")).toBeNull();
    const refreshDeadline = Date.now() + 5_000;
    while (authenticatedHealthReads === 0 || !container.querySelector(".dashboard-workspace-shell")) {
      if (Date.now() >= refreshDeadline) throw new Error("pairing did not refresh the retained failed dashboard store");
      await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
    }
    expect(container.querySelector(".dashboard-workspace-shell")).not.toBeNull();
    expect(container.textContent).not.toContain("ocx start");
    rejectSession = true;
    await act(async () => { expect((await fetch("http://localhost/api/machine/hub-relay/api/system/health")).status).toBe(401); });
    expect(container.querySelector("#connect-pairing-code")).not.toBeNull();
    expect(container.querySelector(".dashboard-workspace-shell")).toBeNull();
    expect(container.textContent).not.toContain("ocx start");

  } finally {
    await act(async () => { root.unmount(); });
    resources.clearClientResourceStoresForTests();
    container.remove();
    win.close();
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
  }
});

test("a refused pairing renders an accessible error without clearing the pasted code", async () => {
  const keys = ["window", "document", "navigator", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  const win = new Window({ url: "http://localhost/" });
  const mockFetch = (async () => new Response("refused", { status: 403 })) as typeof fetch;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win },
    document: { configurable: true, value: win.document },
    navigator: { configurable: true, value: win.navigator },
    sessionStorage: { configurable: true, value: win.sessionStorage },
    fetch: { configurable: true, value: mockFetch },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  Object.defineProperty(win, "fetch", { configurable: true, value: mockFetch });
  const container = document.createElement("div");
  document.body.append(container);
  const { LanguageProvider } = await import("../src/i18n/provider");
  const { ConnectPairingForm } = await import("../src/connect-pairing");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const code = `ocx_pair_${"b".repeat(43)}`;
  try {
    await act(async () => {
      root.render(createElement(LanguageProvider, null, createElement(ConnectPairingForm, {
        target: { id: "shared", baseUrl: "https://hub.example.test", serverOrigin: "https://hub.example.test", bootstrapPath: "https://hub.example.test/opencodex-session", transport: "direct" },
        onConnected: () => { throw new Error("unexpected success"); },
      })));
    });
    const input = container.querySelector("#connect-pairing-code") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, code);
    await act(async () => { input.dispatchEvent(new win.Event("input", { bubbles: true })); });
    await act(async () => { input.closest("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); });
    const deadline = Date.now() + 1_000;
    while (!container.querySelector('[role="alert"]')) {
      if (Date.now() >= deadline) throw new Error("pairing error did not render");
      await act(async () => { await Promise.resolve(); });
    }
    expect(input.value).toBe(code);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    win.close();
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
  }
});


test("a cancelled pairing body cannot install its obsolete session", async () => {
  const { submitConnectPairing } = await import("../src/connect-pairing-transport");
  const controller = new AbortController();
  let release!: (text: string) => void;
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const response = new Response("");
  response.text = () => new Promise<string>(resolve => { release = resolve; reading(); });
  const pending = submitConnectPairing({ id: "shared", baseUrl: "https://hub.example.test",
    serverOrigin: "https://hub.example.test", bootstrapPath: "https://hub.example.test/opencodex-session", transport: "direct" },
    `ocx_pair_${"a".repeat(43)}`, (async () => response) as typeof fetch, controller.signal);
  await started;
  controller.abort();
  release('<meta name="opencodex-session-token" content="ocx_session_obsolete">');
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("pairing reports refusal, server failure and network failure separately", async () => {
  const { submitConnectPairing } = await import("../src/connect-pairing-transport");
  const target = { id: "shared" as const, baseUrl: "https://hub.example.test", serverOrigin: "https://hub.example.test",
    bootstrapPath: "https://hub.example.test/opencodex-session", transport: "direct" as const };
  for (const [status, kind] of [[403, "refused"], [503, "request-failed"]] as const) {
    await expect(submitConnectPairing(target, `ocx_pair_${"a".repeat(43)}`,
      (async () => new Response(null, { status })) as typeof fetch)).rejects.toMatchObject({ kind });
  }
  await expect(submitConnectPairing(target, `ocx_pair_${"a".repeat(43)}`,
    (async () => { throw new Error("network"); }) as typeof fetch)).rejects.toMatchObject({ kind: "unreachable" });
});
