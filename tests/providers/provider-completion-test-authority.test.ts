import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runProviderCompletionTest, handleProviderCompletionTestRoute } from "../../src/server/management/provider-completion-test";
import { fixture, chat } from "../helpers/provider-completion-fixture";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import type { OcxProviderConfig } from "../../src/types";
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
  test("alias wire changes during DNS invalidate the effective authority", async () => {
    const f = fixture({ proxy: "direct", modelAliases: { native: "friendly" }, modelAdapters: { native: "openai-responses" } });
    delete f.row.fetch;
    let sends = 0;
    expect(await f.run("friendly", { outboundDependencies: pinned(() => {
      f.row.modelAdapters!.native = "openai-chat";
    }, () => sends++) })).toMatchObject({ wire: "openai-responses", error: { code: "credential_changed" } });
    expect(sends).toBe(0);
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


describe("local cleartext completion transport", () => {
  for (const name of ["ollama", "vllm", "lm-studio", "litellm"]) test(`${name} registry HTTP default reaches the counted transport`, async () => {
    const entry = PROVIDER_REGISTRY.find(row => row.id === name)!;
    const f = fixture({ baseUrl: entry.baseUrl, authMode: entry.authKind === "local" ? "local" : "key", proxy: "direct" });
    delete f.row.fetch;
    f.config.providers[name] = f.row;
    let sends = 0;
    const result = await runProviderCompletionTest({ config: f.config, name, model: "test-model" }, { outboundDependencies: {
      resolveAddresses: async () => ({ hostname: "localhost", addresses: [{ address: "127.0.0.1", family: 4 }], privateNetwork: true }),
      pinnedPost: async url => { sends++; expect(url).toBe(`${entry.baseUrl}/chat/completions`); return new Response(chat()); },
    } });
    expect(result).toMatchObject({ ok: true, termination: "completed" });
    expect(sends).toBe(1);
    expect(f.row.allowPrivateNetwork).toBeUndefined();
  });
  test("operator opt-in admits a private literal through the executor safeguard", async () => {
    const f = fixture({ baseUrl: "http://192.168.1.10:8000/v1", allowPrivateNetwork: true });
    expect(await f.run()).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(1);
  });
  for (const [baseUrl, allowPrivateNetwork] of [
    ["http://provider.example/v1", true], ["http://93.184.216.34/v1", true],
    ["http://192.168.1.10:8000/v1", false], ["http://169.254.169.254/v1", true],
  ] as const) test(`refused ${baseUrl}, private opt-in ${allowPrivateNetwork}: zero sends`, async () => {
    const f = fixture({ baseUrl, allowPrivateNetwork });
    expect(await f.run()).toMatchObject({ error: { code: "destination_refused" } });
    expect(f.calls).toHaveLength(0);
  });
  test("local HTTP still refuses DNS answers outside the local allowlist", async () => {
    const f = fixture({ baseUrl: "http://localhost:8000/v1", allowPrivateNetwork: true, proxy: "direct" });
    delete f.row.fetch;
    let sends = 0;
    expect(await f.run("test-model", { outboundDependencies: pinned(() => {}, () => sends++) }))
      .toMatchObject({ error: { code: "destination_refused" } });
    expect(sends).toBe(0);
  });
});

const gatewayCases: { name: string; baseUrl: string; defaults: Partial<OcxProviderConfig>; models: Partial<OcxProviderConfig>; expectedDefault: unknown; expectedModel: unknown }[] = [
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",
    defaults: { openRouterRouting: { order: ["default-backend"], allowFallbacks: false } },
    models: { modelOpenRouterRouting: { "native[1m]": { only: ["locked-backend"], allowFallbacks: false } } },
    expectedDefault: { order: ["default-backend"], allow_fallbacks: false }, expectedModel: { only: ["locked-backend"], allow_fallbacks: false } },
  { name: "Vercel", baseUrl: "https://ai-gateway.vercel.sh/v1",
    defaults: { vercelGatewayRouting: { order: ["default-backend"], sort: "cost" } },
    models: { modelVercelGatewayRouting: { "native[1m]": { only: ["locked-backend"], sort: "ttft" } } },
    expectedDefault: { order: ["default-backend"], sort: "cost" }, expectedModel: { only: ["locked-backend"], sort: "ttft" } },
];
describe("completion gateway routing matches the chat adapter", () => {
  for (const gateway of gatewayCases) {
    for (const mode of ["none", "default", "model"] as const) test(`${gateway.name} ${mode} routing uses the native model before suffix stripping`, async () => {
      const f = fixture({ baseUrl: gateway.baseUrl, modelAliases: { "native[1m]": "friendly" }, modelSuffixBracketStrip: true,
        ...(mode === "none" ? {} : gateway.defaults), ...(mode === "model" ? gateway.models : {}) });
      expect(await f.run("friendly")).toMatchObject({ ok: true, wireModel: "native" });
      const actual = JSON.parse(String(f.calls[0]!.init!.body));
      const adapter = createOpenAIChatAdapter(f.row).buildRequest({ modelId: "native[1m]", stream: true,
        context: { messages: [{ role: "user", content: "Reply exactly OK." }], tools: [] }, options: {} });
      const expected = mode === "none" ? undefined : mode === "default" ? gateway.expectedDefault : gateway.expectedModel;
      expect(actual.provider).toEqual(expected);
      expect(actual.provider).toEqual(JSON.parse(String(adapter.body)).provider);
      expect(Object.hasOwn(actual, "provider")).toBe(mode !== "none");
    });
    for (const kind of ["default", "model"] as const) test(`${gateway.name} ${kind} routing mutation during DNS cancels before transport`, async () => {
      const f = fixture({ baseUrl: gateway.baseUrl, proxy: "direct", ...gateway.defaults, ...gateway.models });
      delete f.row.fetch;
      let sends = 0;
      expect(await f.run(kind === "model" ? "native[1m]" : "other-model", { outboundDependencies: pinned(() => {
        if (gateway.name === "OpenRouter") {
          if (kind === "model") f.row.modelOpenRouterRouting!["native[1m]"]!.only!.push("changed");
          else f.row.openRouterRouting!.allowFallbacks = true;
        } else {
          if (kind === "model") f.row.modelVercelGatewayRouting!["native[1m]"]!.only!.push("changed");
          else f.row.vercelGatewayRouting!.sort = "tps";
        }
      }, () => sends++) })).toMatchObject({ error: { code: "credential_changed" } });
      expect(sends).toBe(0);
    });
  }
});
