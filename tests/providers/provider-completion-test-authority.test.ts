import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { handleProviderCompletionTestRoute } from "../../src/server/management/provider-completion-test";
import { fixture, chat } from "../helpers/provider-completion-fixture";
import type { ProviderOutboundDependencies } from "../../src/lib/provider-outbound";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/key-store";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import { createTempHome } from "../helpers/temp-home";
import { saveConfig, getConfigPath } from "../../src/config";
import { healthEvidenceForCandidate, clearHealthHistoryCacheForTests } from "../../src/routing/health";
import { queryRequestHistory, closeRequestHistoryIndex } from "../../src/routing/history/indexer";

const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const previousKey = process.env.OCX_COMPLETION_FIXTURE_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setProviderKeychainEntryFactoryForTests(null);
  for (const key of proxyKeys) {
    const value = originalProxyEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (previousKey === undefined) delete process.env.OCX_COMPLETION_FIXTURE_KEY; else process.env.OCX_COMPLETION_FIXTURE_KEY = previousKey;
});
const addresses = { hostname: "provider.example", addresses: [{ address: "93.184.216.34", family: 4 as const }], privateNetwork: false };
function pinned(mutate: () => void, send: () => void): ProviderOutboundDependencies {
  return {
    resolveAddresses: async () => { mutate(); return addresses; },
    pinnedPost: async () => { send(); return new Response(chat()); },
  };
}

describe("beforeSend request authority fingerprint", () => {
  for (const kind of ["replace", "headers", "baseUrl", "path", "model-wire", "disabled", "private-policy", "key", "keyless-headers", "proxy", "noProxy"] as const) {
    test(`${kind} changed during DNS: zero physical sends`, async () => {
      for (const key of proxyKeys) delete process.env[key];
      const f = fixture({ headers: { "X-Authority": "before" } });
      delete f.row.fetch;
      if (kind === "keyless-headers") { f.row.authMode = "local"; f.row.keyOptional = true; delete f.row.apiKey; }
      let sends = 0;
      const result = await f.run("test-model", { outboundDependencies: pinned(() => {
        switch (kind) {
          case "replace": f.config.providers.fixture = { ...f.row }; break;
          case "headers": case "keyless-headers": f.row.headers!["X-Authority"] = "after"; break;
          case "baseUrl": f.row.baseUrl = "https://other.example/v1"; break;
          case "path": f.row.chatCompletionsPath = "/different"; break;
          case "model-wire": f.row.modelAdapters = { "test-model": "openai-responses" }; break;
          case "disabled": f.row.disabled = true; break;
          case "private-policy": f.row.allowPrivateNetwork = true; break;
          case "key": f.row.apiKey = "after-key"; break;
          case "proxy": f.row.proxy = false; break;
          case "noProxy": f.row.noProxy = "provider.example"; break;
        }
      }, () => sends++) });
      expect(result).toMatchObject({ error: { code: "credential_changed" }, termination: "failed" });
      expect(sends).toBe(0);
      expect(f.calls).toHaveLength(0);
    });
  }
  for (const kind of ["env", "keychain"] as const) test(`${kind} resolved key rotation: zero physical sends`, async () => {
    for (const key of proxyKeys) delete process.env[key];
    let secret = "before-key", sends = 0;
    process.env.OCX_COMPLETION_FIXTURE_KEY = secret;
    const factory = () => ({ getPassword: () => secret, setPassword() {}, deletePassword: () => true });
    setProviderKeychainEntryFactoryForTests(factory);
    const f = fixture({ apiKey: kind === "env" ? "$OCX_COMPLETION_FIXTURE_KEY" : "keychain:fixture" });
    delete f.row.fetch;
    expect(await f.run("test-model", { outboundDependencies: pinned(() => {
      secret = "after-key";
      process.env.OCX_COMPLETION_FIXTURE_KEY = secret;
      setProviderKeychainEntryFactoryForTests(factory);
    }, () => sends++) })).toMatchObject({ error: { code: "credential_changed" } });
    expect(sends).toBe(0);
  });
  test("unchanged keyless authority sends successfully", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const f = fixture({ authMode: "local", keyOptional: true, apiKey: undefined });
    delete f.row.fetch;
    let sends = 0;
    expect(await f.run("test-model", { outboundDependencies: pinned(() => {}, () => sends++) })).toMatchObject({ ok: true });
    expect(sends).toBe(1);
  });
  test("provider direct and proxy egress use the existing outbound transport owner", async () => {
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTPS_PROXY = "http://global-egress.example:3128";
    let pinnedSends = 0;
    const proxies: unknown[] = [];
    globalThis.fetch = (async (_url, init) => {
      proxies.push((init as RequestInit & { proxy?: unknown })?.proxy);
      return new Response(chat());
    }) as typeof fetch;
    for (const proxy of ["direct", "http://provider-egress.example:8080"] as const) {
      const f = fixture({ proxy }); delete f.row.fetch;
      expect(await f.run("test-model", { outboundDependencies: pinned(() => {}, () => pinnedSends++) })).toMatchObject({ ok: true });
    }
    expect(pinnedSends).toBe(1);
    expect(proxies).toEqual(["http://provider-egress.example:8080/"]);
  });
});

describe("completion route concurrency", () => {
  for (const outcome of ["success", "http", "throw", "abort"] as const) test(`409 during ${outcome}, finally releases the provider slot`, async () => {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const controller = new AbortController();
    const f = fixture({}, async () => {
      entered(); await barrier;
      if (outcome === "throw") throw new Error("upstream failure");
      return outcome === "http" ? new Response("failed", { status: 500 }) : new Response(chat());
    });
    const first = f.route(undefined, "fixture", controller.signal);
    await entry;
    expect(await f.route()).toEqual({ status: 409, body: { error: "completion test already running for this provider" } });
    if (outcome === "abort") controller.abort();
    release();
    expect((await first).status).toBe(200);
    expect((await f.route()).status).toBe(200);
    expect(f.calls).toHaveLength(2);
  });
  for (const outcome of ["timeout", "too_large", "stream_error"] as const) test(`${outcome} route releases its occupied slot`, async () => {
    let entered!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture({}, async () => { entered(); return new Response(new ReadableStream({
      start(c) {
        if (outcome === "too_large") setTimeout(() => c.enqueue(new Uint8Array(65537)), 10);
        if (outcome === "stream_error") setTimeout(() => c.enqueue(new TextEncoder().encode('data: {"error":{}}\n\n')), 10);
      },
    })); });
    const invoke = async () => {
      const req = new Request("http://127.0.0.1/api/providers/test-completion?name=fixture", { method: "POST", body: JSON.stringify({ model: "test-model", confirm: true }) });
      return handleProviderCompletionTestRoute({ req, url: new URL(req.url), config: f.config }, { timeoutMs: 30 });
    };
    const first = invoke();
    await entry;
    expect((await invoke()).status).toBe(409);
    expect(await (await first).json()).toMatchObject({ error: { code: outcome } });
    f.row.fetch = (async () => new Response(chat())) as typeof fetch;
    expect(await (await invoke()).json()).toMatchObject({ ok: true });
  });
});

test("diagnostics leave config file, route health and request history unchanged", async () => {
  const home = createTempHome("ocx-completion-unchanged-");
  try {
    const f = fixture();
    saveConfig(f.config);
    const beforeConfig = readFileSync(getConfigPath(), "utf8");
    const beforeHistory = await queryRequestHistory({}, undefined, 20);
    clearHealthHistoryCacheForTests();
    const beforeHealth = healthEvidenceForCandidate({ provider: "fixture", model: "test-model", now: 1_900_000_000_000 });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(readFileSync(getConfigPath(), "utf8")).toBe(beforeConfig);
    const afterHistory = await queryRequestHistory({}, undefined, 20);
    expect(afterHistory.rows).toEqual(beforeHistory.rows);
    clearHealthHistoryCacheForTests();
    expect(healthEvidenceForCandidate({ provider: "fixture", model: "test-model", now: 1_900_000_000_000 })).toEqual(beforeHealth);
  } finally { closeRequestHistoryIndex(); home.remove(); }
});
