import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createTempHome } from "../helpers/temp-home";
import { saveCredential, getCredential, credentialGeneration } from "../../src/oauth/store";
import { OAUTH_PROVIDERS, clearLoginState, getLoginStatus, getValidAccessTokenSnapshot, oauthLoginSummary } from "../../src/oauth";
import { clearModelCache, getProviderLiveModelCount } from "../../src/codex/model-cache";
import { fetchProviderModels } from "../../src/codex/catalog/provider-models";
import { normalizeM365WebSession, parseM365ModelBootstrap, readM365ModelBootstrap, M365_COPILOT_WEB_URL } from "../../src/providers/m365-copilot-discovery";
import { getToneForModel } from "../../src/providers/m365-copilot-models";
import { applyNewModelPolicy } from "../../src/providers/new-model-policy";
import { readM365BrowserWebSession } from "../../src/oauth/m365-copilot-web-session";
import { probeM365CopilotProvider } from "../../src/server/management/m365-copilot-provider-probe";
import { handleOauthAccountRoutes } from "../../src/server/management/oauth-account-routes";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
import type { OcxConfig } from "../../src/types";
import { captureApiTarget, configureApiTargets, targetFetch } from "../../gui/src/api";
import { standaloneApiTargets } from "../../gui/src/api-targets";
import { afterOAuthCancellation, bindOAuthLoginFlow, cancelOAuthLogin, type OAuthLoginAttempt } from "../../gui/src/oauth-cancellation-barrier";

const oid = "11111111-1111-1111-1111-111111111111", tid = "22222222-2222-2222-2222-222222222222";
const accountId = oid + "@" + tid;
const cookie = "OhpAuth=fixture-web-session; SSRUserType=AAD";
const item = (id: string, name = id) => ({ id, type: "item", menuItemTitle: name });
const html = (rows: unknown[] = [item("Magic"), { id: "Claude", type: "itemGroup", itemGroup: [item("Claude_Sonnet", "Sonnet fixture")] }], user = oid) => {
  const h = { loaderData: { root: { store: { accountInfo: { objectId: user, tenantId: tid } }, __queryState: { queries: [{ state: { data: {
    bizchatAsAgentGpt: { clientPreferences: { modelSelectorMetadata: { availableModelSelectionOptions: rows } } },
    agentList: [{ clientPreferences: { modelSelectorMetadata: { availableModelSelectionOptions: [item("Forum")] } } }],
  } } }] } } } };
  return "<script>window.__staticRouterHydrationData = JSON.parse(" + JSON.stringify(JSON.stringify(h)) + ");</script>";
};
const credential = () => ({ access: "header." + Buffer.from(JSON.stringify({ oid, tid, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".signature",
  refresh: "fixture-refresh", expires: Date.now() + 3_600_000, accountId, m365: { cookie, accountId } });
let home: ReturnType<typeof createTempHome>;
const originalFetch = globalThis.fetch;
beforeEach(() => { home = createTempHome("ocx-m365-discovery-"); clearModelCache("m365-copilot"); });
afterEach(() => { globalThis.fetch = originalFetch; clearModelCache("m365-copilot"); home.remove(); });

test("parses only the main account chat roster, nested groups, duplicates and quota status", () => {
  const parsed = parseM365ModelBootstrap(html([item("Magic"), { type: "itemGroup", itemGroup: [item("Claude_Sonnet", "Sonnet fixture"), { ...item("Claude_Opus"), disabled: true }, item("Magic")] }]));
  expect(parsed.accountId).toBe(accountId);
  expect(parsed.items.map(m => m.id)).toEqual(["Magic", "Claude_Sonnet", "Claude_Opus"]);
  expect(parsed.items[2]?.m365_disabled).toBe(true);
  expect(parsed.items.every(m => JSON.stringify(m.input_modalities) === JSON.stringify(["text", "image"]))).toBe(true);
  expect(parsed.items.some(m => m.id === "Forum")).toBe(false);
  expect(getToneForModel("Future_Model_99")).toBe("Future_Model_99");
});
test("rejects missing, malformed, oversized and account-mismatched metadata without executing scripts", async () => {
  expect(() => parseM365ModelBootstrap("<script>throw new Error('never execute');</script>")).toThrow("web sign-in");
  expect(() => parseM365ModelBootstrap(html([item("../../foreign")]))).toThrow("invalid model selector");
  expect(() => parseM365ModelBootstrap(html(Array.from({ length: 257 }, () => item("Magic"))))).toThrow("limits");
  await expect(readM365ModelBootstrap(new Response(html()), tid + "@" + tid)).rejects.toThrow("account mismatch");
  await expect(readM365ModelBootstrap(new Response("x".repeat(2 * 1024 * 1024 + 1)), accountId)).rejects.toThrow("limits");
});
test("stores only bounded account-matched cookies and includes session rotation in credential authority", async () => {
  expect(normalizeM365WebSession({ cookie: cookie + "; foreign=fixture", accountId })).toBeUndefined();
  expect(normalizeM365WebSession({ cookie: "OhpAuth=fixture\r\nX-Injected: value", accountId })).toBeUndefined();
  const c = credential(); await saveCredential("m365-copilot", c);
  expect(getCredential("m365-copilot")?.m365).toEqual(c.m365);
  expect(credentialGeneration({ ...c, m365: { ...c.m365, cookie: "OhpAuth=rotated" } })).not.toBe(credentialGeneration(c));
  const mismatched = { ...c, m365: { cookie, accountId: tid + "@" + tid } };
  await saveCredential("m365-copilot", mismatched);
  expect(getCredential("m365-copilot")?.m365).toBeUndefined();
});
test("live refresh discovers a future selector and the existing new-model policy keeps it disabled until enabled", async () => {
  await saveCredential("m365-copilot", credential()); let calls = 0;
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe(M365_COPILOT_WEB_URL); const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe(cookie); expect(headers.has("authorization")).toBe(false);
    expect(init?.redirect).toBe("manual"); calls++;
    return new Response(html(calls === 1 ? [item("Magic")] : [item("Magic"), item("Future_Model_99", "Future model")]));
  }) as typeof fetch;
  const provider = { ...OAUTH_PROVIDERS["m365-copilot"]!.providerConfig, fetch: ((u, o) => globalThis.fetch(u, o)) as typeof fetch };
  expect((await fetchProviderModels("m365-copilot", provider, 60_000)).map(m => m.id)).toEqual(["Magic"]);
  await fetchProviderModels("m365-copilot", provider, 60_000); expect(calls).toBe(1);
  const next = await fetchProviderModels("m365-copilot", provider, 0);
  expect(next.map(m => m.id)).toEqual(["Magic", "Future_Model_99"]);
  expect(next[1]?.displayName).toBe("M365 Copilot Future model"); expect(getProviderLiveModelCount("m365-copilot")).toBe(2);
  expect(next[1]?.inputModalities).toEqual(["text", "image"]);
  const baseline = applyNewModelPolicy({ provider: "m365-copilot", discoveredIds: ["Magic"], policy: "off", now: "2026-10-27T00:00:00Z" }).nextBaseline;
  const policy = applyNewModelPolicy({ provider: "m365-copilot", discoveredIds: next.map(m => m.id), baseline, policy: "off", now: "2026-10-27T01:00:00Z" });
  expect(policy.newIds).toEqual(["Future_Model_99"]);
  expect(policy.slugsToDisable).toEqual(["m365-copilot/Future_Model_99"]);
});
test("never sends a web cookie to a retargeted provider or publishes aliases after an unauthenticated response", async () => {
  await saveCredential("m365-copilot", credential()); let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("<html>sign in</html>"); }) as typeof fetch;
  const provider = { ...OAUTH_PROVIDERS["m365-copilot"]!.providerConfig, models: ["claude-sonnet"], fetch: ((u, o) => globalThis.fetch(u, o)) as typeof fetch };
  expect(await fetchProviderModels("m365-copilot", { ...provider, baseUrl: "https://example.invalid" }, 0)).toEqual([]);
  expect(calls).toBe(0);
  expect(await fetchProviderModels("m365-copilot", provider, 0)).toEqual([]); expect(calls).toBe(1);
});
test("captures only allowlisted web discovery cookies through Chromium CDP", async () => {
  const methods: string[] = [];
  const browser = { async command(method: string, params?: Record<string, unknown>) {
    methods.push(method);
    if (method === "Runtime.evaluate") return { result: { value: accountId } };
    if (method === "Network.getCookies") return { cookies: [
      { name: "OhpAuth", value: "fixture", domain: ".copilot.cloud.microsoft", path: "/", secure: true },
      { name: "foreign", value: "excluded", domain: ".example.invalid", path: "/", secure: true },
    ] };
    expect(params?.url).toBe(M365_COPILOT_WEB_URL); return {};
  } };
  expect(await readM365BrowserWebSession(browser, "context", new AbortController().signal)).toEqual({ accountId, cookie: "OhpAuth=fixture" });
  expect(methods).toEqual(["Page.navigate", "Runtime.evaluate", "Network.getCookies"]);
});
test("falls back to the server HTML after the page drops its hydration global", async () => {
  const pages = ["<html>sign in</html>", html()];
  const evaluated: Record<string, unknown>[] = [];
  const browser = { async command(method: string, params?: Record<string, unknown>) {
    if (method === "Runtime.evaluate") {
      evaluated.push(params!);
      return { result: { value: params?.awaitPromise ? pages.shift() : "" } };
    }
    if (method === "Network.getCookies") return { cookies: [{ name: "OhpAuth", value: "fixture", domain: "copilot.cloud.microsoft", path: "/", secure: true }] };
    return {};
  } };
  expect(await readM365BrowserWebSession(browser, "context", new AbortController().signal)).toEqual({ accountId, cookie: "OhpAuth=fixture" });
  expect(pages).toHaveLength(0);
  expect(evaluated.filter(p => p.awaitPromise)).toHaveLength(2);
  expect(String(evaluated[1]?.expression)).toContain("credentials:'include'");
});
test("stops polling the web session when the login is aborted", async () => {
  const ctrl = new AbortController();
  let fetches = 0;
  const browser = { async command(method: string, params?: Record<string, unknown>) {
    if (method === "Runtime.evaluate" && params?.awaitPromise && ++fetches === 1) ctrl.abort(new Error("fixture aborted"));
    return method === "Runtime.evaluate" ? { result: { value: "" } } : {};
  } };
  await expect(readM365BrowserWebSession(browser, "context", ctrl.signal)).rejects.toThrow("fixture aborted");
  expect(fetches).toBe(1);
});

test("dashboard connectivity probe uses live account metadata and never treats a stale catalog as connectivity", async () => {
  await saveCredential("m365-copilot", credential());
  const snapshot = await getValidAccessTokenSnapshot("m365-copilot");
  globalThis.fetch = (async () => new Response(html())) as typeof fetch;
  const provider = { ...OAUTH_PROVIDERS["m365-copilot"]!.providerConfig, fetch: ((u, o) => globalThis.fetch(u, o)) as typeof fetch };
  const ok = await probeM365CopilotProvider("m365-copilot", provider, snapshot, new AbortController().signal);
  expect(await ok.json()).toMatchObject({ ok: true, models: 2 });
  globalThis.fetch = (async () => new Response("sign in")) as typeof fetch;
  const failed = await probeM365CopilotProvider("m365-copilot", provider, snapshot, new AbortController().signal);
  expect(await failed.json()).toMatchObject({ ok: false });
});

test("connectivity probe refuses a superseded web session before fetch", async () => {
  const name = "m365-copilot";
  const initial = credential();
  await saveCredential(name, initial);
  const snapshot = await getValidAccessTokenSnapshot(name);
  await saveCredential(name, { ...initial, m365: { ...initial.m365, cookie: "OhpAuth=rotated" } });
  let sends = 0;
  const provider = { ...OAUTH_PROVIDERS[name]!.providerConfig, fetch: (async () => {
    sends++;
    return new Response(html());
  }) as typeof fetch };
  const response = await probeM365CopilotProvider(name, provider, snapshot, new AbortController().signal);
  expect(sends).toBe(0);
  expect(await response.json()).toMatchObject({ ok: false });
});

function stubM365BrowserLogin() {
  const name = "m365-copilot";
  const def = OAUTH_PROVIDERS[name]!;
  const config = { port: 0, hostname: "127.0.0.1", defaultProvider: name, providers: { [name]: def.providerConfig } } as OcxConfig;
  const started: AbortSignal[] = [];
  const login = spyOn(def, "login").mockImplementation(async ctrl => {
    started.push(ctrl.signal!);
    ctrl.onAuth?.({ url: "", instructions: "Fixture login " + started.length });
    return new Promise((_, reject) => ctrl.signal!.addEventListener("abort", () => reject(new Error("fixture cancelled")), { once: true }));
  });
  const handle = async (req: Request) => {
    return (await handleOauthAccountRoutes({
      req, url: new URL(req.url), config, deps: {},
      convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }),
      syncClaudeAgentDefsBestEffort: async () => {},
    }))!;
  };
  const restore = () => {
    clearLoginState(name);
    login.mockRestore();
  };
  return { name, handle, started, restore };
}

test("management status and cancel bind a tab to its own M365 login attempt", async () => {
  const { name, handle, started, restore } = stubM365BrowserLogin();
  const request = (path: string, body?: object) => handle(new Request(new URL(path, "http://127.0.0.1"),
    body ? { method: "POST", body: JSON.stringify({ provider: name, ...body }) } : {}));
  const start = async () => {
    const response = await request("/api/oauth/login", { openBrowser: true });
    expect(response.status).toBe(200);
    return await response.json() as { flowId: string };
  };
  const cancel = (flowId?: string) => request("/api/oauth/login/cancel", { flowId });
  const status = (flowId?: string) => request("/api/oauth/status?provider=" + name + (flowId ? "&flowId=" + flowId : ""));
  try {
    const old = await start();
    expect(typeof old.flowId).toBe("string");
    expect(await (await cancel(old.flowId)).json()).toMatchObject({ cancelled: true });
    const replacement = await start();
    expect(replacement.flowId).not.toBe(old.flowId);
    expect((await status()).status).toBe(404);
    expect((await cancel()).status).toBe(404);
    const oldStatus = await (await status(old.flowId)).json();
    expect(oldStatus).toMatchObject({ flowId: old.flowId, status: "error" });
    expect(oldStatus.hint).toBeUndefined();
    expect((await status("unknown")).status).toBe(404);
    expect(await (await cancel(old.flowId)).json()).toMatchObject({ cancelled: true });
    expect(started[1]?.aborted).toBe(false);
    expect(await (await status(replacement.flowId)).json()).toMatchObject({ flowId: replacement.flowId, status: "pending", hint: { instructions: "Fixture login 2" } });
    expect(await (await request("/api/oauth/status?provider=" + name + "&summary=1")).json())
      .toEqual({ loggedIn: false, done: false, status: "idle" });
    expect(await (await cancel(replacement.flowId)).json()).toMatchObject({ cancelled: true });
    expect(started[1]?.aborted).toBe(true);
  } finally {
    restore();
  }
});

test("dashboard retry after cancelling a starting M365 login succeeds with its own flow", async () => {
  const { name, handle, started, restore } = stubM365BrowserLogin();
  const apiBase = "http://127.0.0.1";
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: apiBase } } });
  configureApiTargets(standaloneApiTargets(apiBase));
  const originalResponse = Promise.withResolvers<Response>();
  const releaseStart = Promise.withResolvers<void>();
  const cancelArrived = Promise.withResolvers<void>();
  const releaseCancel = Promise.withResolvers<void>();
  const starts: Promise<Response>[] = [];
  const cancels: unknown[] = [];
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).pathname === "/api/oauth/login/cancel") {
      cancels.push(await req.clone().json());
      cancelArrived.resolve();
      await releaseCancel.promise;
      return handle(req);
    }
    const response = handle(req);
    starts.push(response);
    if (starts.length === 1) {
      originalResponse.resolve(await response);
      await releaseStart.promise;
    }
    return response;
  }) as typeof fetch;

  const start = (attempt: OAuthLoginAttempt) => afterOAuthCancellation(attempt, name, async () => {
    const response = await targetFetch(attempt, `${apiBase}/api/oauth/login`, {
      method: "POST",
      body: JSON.stringify({ provider: name, openBrowser: true }),
    });
    if (response.ok) bindOAuthLoginFlow(attempt, name, (await response.json()).flowId);
    return response.status;
  });

  try {
    const original: OAuthLoginAttempt = captureApiTarget();
    const replacement: OAuthLoginAttempt = captureApiTarget();
    const originalStart = start(original);
    expect((await originalResponse.promise).status).toBe(200);
    const cancel = cancelOAuthLogin(original, name);
    const retry = start(replacement);
    releaseStart.resolve();
    expect(await originalStart).toBe(200);
    await cancelArrived.promise;
    const prematureRetry = starts[1];
    // If a retry escaped, let it reach the still-pending flow before releasing Cancel.
    if (prematureRetry) await prematureRetry;
    releaseCancel.resolve();
    expect(await retry).toBe(200);
    await cancel;
    expect(prematureRetry).toBeUndefined();
    expect(original.flowId).toBeString();
    expect(cancels).toEqual([{ provider: name, flowId: original.flowId }]);
    expect(replacement.flowId).toBeString();
    expect(replacement.flowId).not.toBe(original.flowId);
    expect(started.map(signal => signal.aborted)).toEqual([true, false]);
  } finally {
    releaseStart.resolve();
    releaseCancel.resolve();
    restore();
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("keeps the M365 web cookie out of account summaries, management responses and discovery logs", async () => {
  const name = "m365-copilot";
  const logged: string[] = [];
  const logs = (["debug", "log", "info", "warn", "error"] as const).map(level =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(Bun.inspect(args, { depth: 10 }));
    }));
  const requests: Array<{ url: string; sentCookie: string | null }> = [];
  const provider = {
    ...OAUTH_PROVIDERS[name]!.providerConfig,
    fetch: (async (url, init) => {
      requests.push({ url: String(url), sentCookie: new Headers(init?.headers).get("cookie") });
      throw new Error(`Upstream fixture echoed the request cookie: ${cookie}`);
    }) as typeof fetch,
  };
  const config = { port: 0, hostname: "127.0.0.1", defaultProvider: name, providers: { [name]: provider } } as OcxConfig;
  async function read(path: string, method = "GET") {
    const url = new URL(path, "http://127.0.0.1");
    const context: Parameters<typeof handleOauthAccountRoutes>[0] = {
      req: new Request(url, { method }), url, config, deps: {},
      convergeCodexCatalog: async () => ({ status: "failed", reason: "disk" }),
      syncClaudeAgentDefsBestEffort: async () => {},
    };
    const response = await (path.startsWith("/api/oauth/")
      ? handleOauthAccountRoutes(context)
      : handleProviderRoutes(context));
    expect(response?.status, path).toBe(200);
    return response!.json();
  }
  function expectNoCookie(value: unknown) {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('"m365":');
    expect(serialized).not.toContain("OhpAuth");
    expect(serialized).not.toContain("fixture-web-session");
  }
  try {
    await saveCredential(name, credential());
    expect(getCredential(name)?.m365?.cookie).toBe(cookie);
    const summary = oauthLoginSummary().find(row => row.provider === name);
    expect(summary).toMatchObject({ provider: name, loggedIn: true });
    expectNoCookie(summary);
    const status = getLoginStatus(name);
    expect(status.accounts).toHaveLength(1);
    expectNoCookie(status);

    const accountStatus = await read(`/api/oauth/status?provider=${name}&summary=1`);
    const accounts = await read(`/api/oauth/accounts?provider=${name}`);
    const providers = await read("/api/providers");
    expect(accountStatus).toMatchObject({ loggedIn: true });
    expect(accounts.accounts).toHaveLength(1);
    expect(providers).toContainEqual(expect.objectContaining({ name }));
    expectNoCookie([accountStatus, accounts, providers]);

    const probe = await read(`/api/providers/test?name=${name}`, "POST");
    expect(probe).toMatchObject({ ok: false, error: expect.stringContaining("live discovery failed") });
    expectNoCookie(probe);
    expect(await fetchProviderModels(name, provider, 0)).toEqual([]);
    expect(requests).toEqual([
      { url: M365_COPILOT_WEB_URL, sentCookie: cookie },
      { url: M365_COPILOT_WEB_URL, sentCookie: cookie },
    ]);
    expectNoCookie(logged);
  } finally {
    for (const spy of logs) spy.mockRestore();
  }
});
