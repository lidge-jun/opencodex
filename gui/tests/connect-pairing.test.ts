import { expect, test } from "bun:test";
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

test("pairing distinguishes expired or origin-bound grants, HTTP 403, server failure and network failure", async () => {
  const { submitConnectPairing } = await import("../src/connect-pairing-transport");
  const target = { id: "shared" as const, baseUrl: "https://hub.example.test", serverOrigin: "https://hub.example.test",
    bootstrapPath: "https://hub.example.test/opencodex-session", transport: "direct" as const };
  for (const [status, kind] of [[401, "refused"], [403, "origin-denied"], [503, "request-failed"]] as const) {
    await expect(submitConnectPairing(target, `ocx_pair_${"a".repeat(43)}`,
      (async () => new Response(null, { status })) as typeof fetch)).rejects.toMatchObject({ kind });
  }
  await expect(submitConnectPairing(target, `ocx_pair_${"a".repeat(43)}`,
    (async () => { throw new Error("network"); }) as typeof fetch)).rejects.toMatchObject({ kind: "unreachable" });
});

test("pairing identifies Cloudflare HTML challenges without surfacing their body", async () => {
  const { submitConnectPairing } = await import("../src/connect-pairing-transport");
  const target = { id: "shared" as const, baseUrl: "https://hub.example.test", serverOrigin: "https://hub.example.test",
    bootstrapPath: "https://hub.example.test/opencodex-session", transport: "direct" as const };
  const code = `ocx_pair_${"a".repeat(43)}`;
  await expect(submitConnectPairing(target, code, (async () => new Response("challenge-content-secret", {
    status: 403,
    headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
  })) as typeof fetch)).rejects.toMatchObject({ kind: "cloudflare-challenge" });
  await expect(submitConnectPairing(target, code, (async () => new Response(
    "<html><title>Just a moment...</title><script>challenge-platform</script></html>",
    { status: 200, headers: { "content-type": "text/html" } },
  )) as typeof fetch)).rejects.toMatchObject({ kind: "cloudflare-challenge" });
});

test("Remote Link session validation distinguishes 401, 403 and Cloudflare challenges", async () => {
  const { validateRemoteLinkSession } = await import("../src/connect-pairing-transport");
  for (const [status, kind] of [[401, "remote-link-unauthorized"], [403, "remote-link-forbidden"], [503, "request-failed"]] as const) {
    await expect(validateRemoteLinkSession("https://hub.example.test", (async () => new Response(null, { status })) as typeof fetch))
      .rejects.toMatchObject({ kind });
  }
  await expect(validateRemoteLinkSession("https://hub.example.test", (async () => new Response(
    "<html><title>Just a moment...</title><script>challenge-platform</script></html>",
    { status: 403, headers: { "content-type": "text/html" } },
  )) as typeof fetch)).rejects.toMatchObject({ kind: "cloudflare-challenge" });
});

test("pairing refuses a returned session bound to a different browser origin", async () => {
  const previousWindow = Reflect.get(globalThis, "window");
  const previousDocument = Reflect.get(globalThis, "document");
  const win = new Window({ url: "https://browser.example.test/#remote" });
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win },
    document: { configurable: true, value: win.document },
  });
  const { resetApiAuthFetchForTests, configureApiTargets, hasApiSession } = await import("../src/api");
  const { standaloneApiTargets } = await import("../src/api-targets");
  const { submitConnectPairing } = await import("../src/connect-pairing-transport");
  resetApiAuthFetchForTests();
  configureApiTargets(standaloneApiTargets("https://hub.example.test"));
  const target = { id: "shared" as const, baseUrl: "https://hub.example.test", serverOrigin: "https://hub.example.test",
    bootstrapPath: "https://hub.example.test/opencodex-session", transport: "direct" as const };
  try {
    await expect(submitConnectPairing(target, `ocx_pair_${"a".repeat(43)}`, (async () => new Response([
      '<meta name="opencodex-session-token" content="ocx_session_origin_fixture">',
      '<meta name="opencodex-session-csrf" content="fixture-csrf">',
      '<meta name="opencodex-session-origin" content="https://different.example.test">',
      '<meta name="opencodex-session-server-origin" content="https://hub.example.test">',
    ].join(""), { headers: { "content-type": "text/html" } })) as typeof fetch)).rejects.toMatchObject({ kind: "invalid-response" });
    expect(hasApiSession("shared")).toBe(false);
  } finally {
    resetApiAuthFetchForTests();
    win.close();
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: previousWindow },
      document: { configurable: true, value: previousDocument },
    });
  }
});


test("cancelled Remote Link validation forwards the abort signal and rejects a late response", async () => {
  const { validateRemoteLinkSession } = await import("../src/connect-pairing-transport");
  const controller = new AbortController();
  let release!: (response: Response) => void;
  let observedSignal: AbortSignal | null | undefined;
  const pending = validateRemoteLinkSession("https://hub.example.test", (async (_input, init) => {
    observedSignal = init?.signal;
    return new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch, controller.signal);
  expect(observedSignal).toBe(controller.signal);
  controller.abort();
  release(Response.json({ role: "standalone", listener: { state: "off", port: null }, links: [], child: null }));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

async function withPairingValidation(
  firstValidation: () => Response,
  check: (fixture: {
    container: HTMLDivElement; input: HTMLInputElement; submit: () => Promise<void>;
    retry: () => Promise<void>; close: () => Promise<void>; sessionIs: (kind: string) => Promise<boolean>;
    counts: { posts: number; validations: number; connected: number; bootstraps: number };
  }) => Promise<void>,
) {
  const keys = ["window", "document", "navigator", "sessionStorage", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  const win = new Window({ url: "http://localhost/#remote" });
  for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator,
    sessionStorage: win.sessionStorage, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const counts = { posts: 0, validations: 0, connected: 0, bootstraps: 0 };
  const html = (kind: string) => [
    `<meta name="opencodex-session-token" content="ocx_session_${kind}">`,
    `<meta name="opencodex-session-csrf" content="${kind}-csrf">`,
    '<meta name="opencodex-session-origin" content="http://localhost">',
    '<meta name="opencodex-session-server-origin" content="https://hub.example.test">',
  ].join("");
  const mockFetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/opencodex-session")) {
      if (init?.method !== "POST") { counts.bootstraps++; return new Response(null, { status: 401 }); }
      counts.posts++;
      return new Response(html("candidate"), { headers: { "content-type": "text/html" } });
    }
    const headers = new Headers(init?.headers);
    if (url.endsWith("/api/link/status")) {
      expect(headers.get("x-opencodex-api-key")).toBe("ocx_session_candidate");
      if (++counts.validations === 1) return firstValidation();
      return Response.json({ role: "standalone", listener: { state: "off", port: null }, links: [], child: null });
    }
    // Observe the entire restored session through authenticated requests, never a token getter.
    return Response.json({ previous: headers.get("x-opencodex-api-key") === "ocx_session_previous"
      && headers.get("x-opencodex-csrf-token") === "previous-csrf"
      && headers.get("x-opencodex-gui-origin") === "http://localhost",
      candidate: headers.get("x-opencodex-api-key") === "ocx_session_candidate" });
  }) as typeof fetch;
  Object.defineProperty(win, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  const api = await import("../src/api");
  const { standaloneApiTargets } = await import("../src/api-targets");
  const { validateRemoteLinkSession } = await import("../src/connect-pairing-transport");
  const targets = standaloneApiTargets("https://hub.example.test");
  api.resetApiAuthFetchForTests();
  api.configureApiTargets(targets);
  api.installApiAuthFetch();
  api.installApiSessionFromHtml("shared", html("previous"));
  const { LanguageProvider } = await import("../src/i18n/provider");
  const { ConnectPairingForm } = await import("../src/connect-pairing");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(LanguageProvider, null, createElement(ConnectPairingForm, {
      target: targets.shared,
      onConnected: async signal => { await validateRemoteLinkSession(targets.shared.baseUrl, undefined, signal); counts.connected++; },
    }))));
    const input = container.querySelector("#connect-pairing-code") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, `ocx_pair_${"c".repeat(43)}`);
    await act(async () => { input.dispatchEvent(new win.Event("input", { bubbles: true })); });
    await check({ container, input, counts,
      submit: () => act(async () => { input.closest("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); }),
      retry: () => act(async () => {
        const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Retry validation");
        expect(button).toBeDefined();
        button!.click();
      }),
      close: () => act(async () => root.render(null)),
      sessionIs: async kind => (await (await win.fetch(`${targets.shared.baseUrl}/api/check-session`, { method: "POST" })).json())[kind] === true,
    });
  } finally {
    await act(async () => root.unmount());
    api.resetApiAuthFetchForTests();
    win.close();
    for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
  }
}

test.each(["network", "5xx", "malformed"] as const)("%s validation failure retries the installed session without another pairing POST", async failure => {
  await withPairingValidation(() => {
    if (failure === "network") throw new Error("offline");
    return failure === "5xx" ? new Response(null, { status: 503 }) : Response.json({ invalid: true });
  }, async ({ container, input, submit, retry, close, sessionIs, counts }) => {
    await submit();
    expect(counts.connected).toBe(0);
    expect(input.value).toBe("");
    expect(input.disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Retry validation");
    expect(await sessionIs("candidate")).toBe(true);
    await retry();
    expect(counts).toEqual({ posts: 1, validations: 2, connected: 1, bootstraps: 0 });
    expect(await sessionIs("candidate")).toBe(true);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(winStorageHasSession()).toBe(false);
    await close();
    expect(await sessionIs("candidate")).toBe(true);
  });
});

test("leaving a pending validation restores the previous session", async () => {
  await withPairingValidation(() => new Response(null, { status: 503 }), async ({ submit, close, sessionIs }) => {
    await submit();
    expect(await sessionIs("candidate")).toBe(true);
    await close();
    expect(await sessionIs("previous")).toBe(true);
  });
});

function winStorageHasSession(): boolean {
  return Object.keys(sessionStorage).some(key => /session|token/i.test(key))
    || Object.keys(localStorage).some(key => /session|token/i.test(key));
}

test.each([401, 403])("validation HTTP %i restores the previous shared session", async status => {
  await withPairingValidation(() => new Response(null, { status }), async ({ container, input, submit, sessionIs, counts }) => {
    await submit();
    expect(counts).toEqual({ posts: 1, validations: 1, connected: 0, bootstraps: 0 });
    expect(await sessionIs("previous")).toBe(true);
    expect(input.value).toBe("");
    expect(input.disabled).toBe(false);
    expect(container.textContent).not.toContain("Retry validation");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("cannot manage Remote Link");
    expect(winStorageHasSession()).toBe(false);
  });
});
