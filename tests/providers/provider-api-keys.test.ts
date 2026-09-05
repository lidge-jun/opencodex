import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { listProviderApiKeys } from "../../src/providers/api-keys";
import { clearProviderQuotaCache, fetchProviderApiKeyQuotas, fetchProviderQuotaReports, providerApiKeyQuotaMode } from "../../src/providers/quota";

const originalUpstreamFetch = globalThis.fetch;

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "key-first-000111222333" },
    },
  } as OcxConfig;
}

beforeEach(() => {
  clearProviderQuotaCache();
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-provider-keys-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-provider-keys-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  globalThis.fetch = originalUpstreamFetch;
  clearProviderQuotaCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("provider API key pool", () => {
  test("cheap legacy projection never mutates even frozen config or writes config", () => {
    const config = baseConfig();
    const disk = readFileSync(join(testDir, "config.json"), "utf8");
    Object.freeze(config.providers["opencode-go"]);
    Object.freeze(config.providers);
    Object.freeze(config);
    const first = listProviderApiKeys(config, "opencode-go");
    expect(listProviderApiKeys(config, "opencode-go")).toEqual(first);
    expect(first.keys).toHaveLength(1);
    expect(first.keys[0]?.active).toBe(true);
    expect(config.providers["opencode-go"]?.apiKeyPool).toBeUndefined();
    expect(readFileSync(join(testDir, "config.json"), "utf8")).toBe(disk);
  });
  test("GET seeds legacy bare apiKey into a one-entry pool with masked value", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { activeId: string | null; keys: Array<{ id: string; masked: string; active: boolean }> };
      expect(body.keys.length).toBe(1);
      expect(body.keys[0]!.active).toBe(true);
      expect(body.keys[0]!.masked.includes("****")).toBe(true);
      expect(JSON.stringify(body).includes("key-first-000111222333")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("POST adds + activates; PUT switches; DELETE removes and promotes", async () => {
    const server = startServer(0);
    try {
      const add = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "key-second-444555666777" }),
      });
      expect(add.status).toBe(201);
      const { id: secondId } = await add.json() as { id: string };

      let list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as { activeId: string; keys: Array<{ id: string; active: boolean }> };
      expect(list.keys.length).toBe(2);
      expect(list.activeId).toBe(secondId); // new key becomes active

      // config.json mirrors the active key into apiKey
      const cfg = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      expect(cfg.providers["opencode-go"].apiKey).toBe("key-second-444555666777");

      const firstId = list.keys.find(k => k.id !== secondId)!.id;
      const rename = await fetch(new URL("/api/providers/keys/alias", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: secondId, alias: "Work key" }),
      });
      expect(rename.status).toBe(200);
      const renamed = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as { keys: Array<{ id: string; label?: string }> };
      expect(renamed.keys.find(key => key.id === secondId)?.label).toBe("Work key");
      const put = await fetch(new URL("/api/providers/keys/active", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", id: firstId }),
      });
      expect(put.status).toBe(200);
      list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as typeof list;
      expect(list.activeId).toBe(firstId);

      // Remove the active key: the other one is promoted.
      const del = await fetch(new URL(`/api/providers/keys?name=opencode-go&id=${firstId}`, server.url), { method: "DELETE" });
      expect(del.status).toBe(200);
      list = await fetch(new URL("/api/providers/keys?name=opencode-go", server.url)).then(r => r.json()) as typeof list;
      expect(list.keys.length).toBe(1);
      expect(list.activeId).toBe(secondId);
      const cfg2 = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8"));
      expect(cfg2.providers["opencode-go"].apiKey).toBe("key-second-444555666777");
    } finally {
      await server.stop(true);
    }
  });

  test("unknown provider 404; empty key 400", async () => {
    const server = startServer(0);
    try {
      const missing = await fetch(new URL("/api/providers/keys?name=nope", server.url));
      expect(missing.status).toBe(404);
      const bad = await fetch(new URL("/api/providers/keys", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "opencode-go", key: "   " }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });
});

function quotaKeyConfig(count = 2): OcxConfig {
  return {
    defaultProvider: "openrouter",
    providers: { openrouter: {
      adapter: "openai-chat", authMode: "key", baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "fixture-key-0", apiKeyPool: Array.from({ length: count }, (_, i) => ({ id: `slot-${i}`, key: `fixture-key-${i}` })),
    } },
  } as OcxConfig;
}

function keyQuotaResponse(percent: number): Response {
  return Response.json({ data: { limit: 100, limit_remaining: 100 - percent } });
}

describe("credential-scoped key quota", () => {
  test("the integrated Ollama Cloud reader supports each key without changing active configuration", async () => {
    const provider = { adapter: "openai-chat", authMode: "key" as const, baseUrl: "https://ollama.com", apiKey: "fixture-first",
      apiKeyPool: [{ id: "first", key: "fixture-first" }, { id: "second", key: "fixture-second" }] };
    const config: OcxConfig = { port: 0, defaultProvider: "cloud-copy", providers: { "cloud-copy": provider } };
    const before = JSON.stringify(config);
    expect(providerApiKeyQuotaMode("cloud-copy", provider)).toBe("probe");
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://ollama.com/api/usage");
      expect(init?.redirect).toBe("error");
      const first = new Headers(init?.headers).get("authorization") === "Bearer fixture-first";
      return Response.json({ limits: { monthly: { usage: first ? 0.25 : 0.75 } } });
    }) as typeof globalThis.fetch;
    const rows = await fetchProviderApiKeyQuotas(config, "cloud-copy");
    expect(rows.map(row => row.quota?.monthlyPercent)).toEqual([25, 75]);
    expect(JSON.stringify(config)).toBe(before);
    expect(providerApiKeyQuotaMode("cloud-copy", { ...provider, baseUrl: "https://ollama.example.invalid" })).toBe("unsupported");
  });

  test("canonical Kimi keys retain the default key auth mode when authMode is omitted", async () => {
    const provider = { adapter: "openai-chat", baseUrl: "https://api.kimi.com/coding/v1", apiKey: "fixture-kimi-key" };
    const config: OcxConfig = { port: 0, defaultProvider: "coding-alias", providers: { "coding-alias": provider } };
    expect(providerApiKeyQuotaMode("coding-alias", provider)).toBe("probe");
    let calls = 0;
    globalThis.fetch = (async (input, init) => {
      calls++;
      expect(String(input)).toBe("https://api.kimi.com/coding/v1/usages");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-kimi-key");
      return Response.json({ usage: { limit: 100, used: 25 } });
    }) as typeof globalThis.fetch;
    const [row] = await fetchProviderApiKeyQuotas(config, "coding-alias");
    expect(row?.quota?.weeklyPercent).toBe(25);
    expect(row?.isCurrent()).toBe(true);
    expect(calls).toBe(1);
    expect(providerApiKeyQuotaMode("coding-alias", { ...provider, authMode: "forward" })).toBe("unsupported");
  });

  test("key probe failure drops last-good quota that expires during the upstream await", async () => {
    const config = quotaKeyConfig(1);
    const realDateNow = Date.now;
    const observedAt = realDateNow();
    let now = observedAt;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return keyQuotaResponse(25);
      expect(now).toBe(observedAt + 29 * 60_000 + 59_000);
      now = observedAt + 30 * 60_000;
      return new Response("{}", { status: 429 });
    }) as typeof globalThis.fetch;
    Date.now = () => now;
    try {
      expect((await fetchProviderApiKeyQuotas(config, "openrouter"))[0]?.quota?.updatedAt).toBe(observedAt);
      now = observedAt + 29 * 60_000 + 59_000;
      const [failed] = await fetchProviderApiKeyQuotas(config, "openrouter", true);
      expect(calls).toBe(2);
      expect(failed?.quota).toBeNull();
      expect(failed?.unavailable).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("a recent failed key probe cannot extend a last-good measurement past thirty minutes", async () => {
    const config = quotaKeyConfig(1);
    const realDateNow = Date.now;
    const observedAt = realDateNow();
    let now = observedAt;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? keyQuotaResponse(25) : new Response("{}", { status: 429 });
    }) as typeof globalThis.fetch;
    Date.now = () => now;
    try {
      const [initial] = await fetchProviderApiKeyQuotas(config, "openrouter");
      expect(initial?.quota?.updatedAt).toBe(observedAt);
      now = observedAt + 29 * 60_000 + 59_000;
      const [failed] = await fetchProviderApiKeyQuotas(config, "openrouter", true);
      expect(failed?.unavailable).toBe(true);
      expect(failed?.quota?.updatedAt).toBe(observedAt);
      expect(calls).toBe(2);
      // The attempt is only one second old, but the measurement has reached its bound.
      now += 1_000;
      const [expired] = await fetchProviderApiKeyQuotas(config, "openrouter");
      expect(expired?.quota).toBeNull();
      expect(expired?.unavailable).toBe(true);
      expect(calls).toBe(3);
      now += 1;
      expect((await fetchProviderApiKeyQuotas(config, "openrouter"))[0]?.quota).toBeNull();
      expect(calls).toBe(3); // Negative caching still works once the old measurement is gone.
    } finally {
      Date.now = realDateNow;
    }
  });

  test("capability uses all existing key reader destinations without resolving secrets", () => {
    const targets = [
      ["coding-alias", "https://api.kimi.com/coding/v1"],
      ["commandcode", "https://api.commandcode.ai/provider/v1"],
      ["go-alias", "https://opencode.ai/zen/go/v1"],
      ["a6-alias", "https://api.a6api.com/v1"],
      ["openrouter", "https://openrouter.ai/api/v1"],
      ["deepseek", "https://api.deepseek.com/v1"],
      ["cline-pass", "https://api.cline.bot"],
      ["glm-cn", "https://open.bigmodel.cn/api/coding/paas/v4"],
      ["minimax", "https://api.minimax.io/v1"],
      ["moonshot", "https://api.moonshot.ai/v1"],
      ["venice", "https://api.venice.ai/api/v1"],
      ["synthetic", "https://api.synthetic.new/v2"],
      ["deepinfra", "https://api.deepinfra.com/v1/openai"],
      ["neuralwatt", "https://api.neuralwatt.com/v1"],
    ] as const;
    for (const [name, baseUrl] of targets) {
      expect(providerApiKeyQuotaMode(name, { baseUrl, adapter: "openai-chat", authMode: "key" })).toBe("probe");
      expect(providerApiKeyQuotaMode(name, { baseUrl, adapter: "openai-chat", authMode: "key", disabled: true })).toBe("unsupported");
    }
  });

  test("env-reference replacement cannot reuse a quota or fall back to the active key", async () => {
    const envName = "OCX_QUOTA_KEY_FIXTURE";
    const previous = process.env[envName];
    const config = quotaKeyConfig(2);
    config.providers.openrouter!.apiKeyPool![1]!.key = `$${envName}`;
    const seen: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return keyQuotaResponse(44);
    }) as typeof globalThis.fetch;
    try {
      process.env[envName] = "env-first-fixture";
      const first = await fetchProviderApiKeyQuotas(config, "openrouter");
      process.env[envName] = "env-second-fixture";
      expect(first[1]!.isCurrent()).toBe(false);
      await fetchProviderApiKeyQuotas(config, "openrouter");
      expect(seen).toEqual(["Bearer fixture-key-0", "Bearer env-first-fixture", "Bearer env-second-fixture"]);
      delete process.env[envName];
      const missing = await fetchProviderApiKeyQuotas(config, "openrouter");
      expect(missing[1]?.quota).toBeNull();
      expect(missing[1]?.unavailable).toBe(true);
      expect(seen).toHaveLength(3);
    } finally {
      if (previous === undefined) delete process.env[envName];
      else process.env[envName] = previous;
    }
  });

  test("key quota cache is bounded and a different provider cannot reuse the same slot", async () => {
    const config = quotaKeyConfig(257);
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return keyQuotaResponse(11); }) as typeof globalThis.fetch;
    await fetchProviderApiKeyQuotas(config, "openrouter");
    expect(calls).toBe(257);
    config.providers.openrouter!.apiKeyPool = [config.providers.openrouter!.apiKeyPool![0]!];
    await fetchProviderApiKeyQuotas(config, "openrouter");
    expect(calls).toBe(258);
    config.providers.synthetic = { ...config.providers.openrouter!, baseUrl: "https://api.synthetic.new/v2" };
    await fetchProviderApiKeyQuotas(config, "synthetic");
    expect(calls).toBe(259);
  });

  test("isolates inactive keys and leaves provider reports, config and active key unchanged", async () => {
    const config = quotaKeyConfig();
    const before = JSON.stringify(config);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      return keyQuotaResponse(auth === "Bearer fixture-key-0" ? 10 : 75);
    }) as typeof globalThis.fetch;
    const current = await fetchProviderQuotaReports(config, true);
    const rows = await fetchProviderApiKeyQuotas(config, "openrouter");
    expect(rows.map(row => row.quota?.customWindows?.[0]?.percent)).toEqual([10, 75]);
    expect(rows.every(row => row.isCurrent())).toBe(true);
    expect(Object.keys(rows[0]!)).toEqual(["keyId", "quota"]);
    expect(JSON.stringify(rows)).not.toContain("fixture-key");
    expect(JSON.stringify(rows)).not.toContain("isCurrent");
    expect(JSON.stringify(config)).toBe(before);
    expect(await fetchProviderQuotaReports(config)).toEqual(current);
  });

  test("same-id replacement and clear invalidate nonenumerable current guards", async () => {
    const config = quotaKeyConfig(1);
    globalThis.fetch = (async () => keyQuotaResponse(25)) as typeof globalThis.fetch;
    const [first] = await fetchProviderApiKeyQuotas(config, "openrouter");
    expect(first!.isCurrent()).toBe(true);
    config.providers.openrouter!.apiKeyPool![0]!.key = "replacement-fixture";
    expect(first!.isCurrent()).toBe(false);
    const [replacement] = await fetchProviderApiKeyQuotas(config, "openrouter");
    expect(replacement!.isCurrent()).toBe(true);
    clearProviderQuotaCache();
    expect(replacement!.isCurrent()).toBe(false);
  });

  test("force bypasses settled success/failure TTL but joins same-identity in-flight work", async () => {
    const config = quotaKeyConfig(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    let status = 200;
    globalThis.fetch = (async () => {
      calls += 1;
      started();
      await gate;
      return status === 200 ? keyQuotaResponse(10) : new Response("{}", { status });
    }) as typeof globalThis.fetch;
    const first = fetchProviderApiKeyQuotas(config, "openrouter");
    await entered;
    const forced = fetchProviderApiKeyQuotas(config, "openrouter", true);
    release();
    await Promise.all([first, forced]);
    expect(calls).toBe(1);
    await fetchProviderApiKeyQuotas(config, "openrouter");
    expect(calls).toBe(1);
    status = 429;
    const [failed] = await fetchProviderApiKeyQuotas(config, "openrouter", true);
    expect(failed?.unavailable).toBe(true);
    expect(failed?.quota?.customWindows?.[0]?.percent).toBe(10);
    await fetchProviderApiKeyQuotas(config, "openrouter");
    expect(calls).toBe(2);
    status = 401;
    expect((await fetchProviderApiKeyQuotas(config, "openrouter", true))[0]?.quota).toBeNull();
    status = 200;
    expect((await fetchProviderApiKeyQuotas(config, "openrouter", true))[0]?.unavailable).toBeUndefined();
    expect(calls).toBe(4);
  });

  test("four workers bound a key roster and late removed rows cannot publish", async () => {
    const config = quotaKeyConfig(7);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fourStarted!: () => void;
    const entered = new Promise<void>(resolve => { fourStarted = resolve; });
    let active = 0;
    let peak = 0;
    let calls = 0;
    globalThis.fetch = (async () => {
      active += 1; calls += 1; peak = Math.max(peak, active);
      if (calls === 4) fourStarted();
      await gate;
      active -= 1;
      return keyQuotaResponse(33);
    }) as typeof globalThis.fetch;
    const pending = fetchProviderApiKeyQuotas(config, "openrouter");
    await entered;
    config.providers.openrouter!.apiKeyPool = config.providers.openrouter!.apiKeyPool!.filter(row => row.id !== "slot-0");
    release();
    const rows = await pending;
    expect(peak).toBe(4);
    expect(rows).toHaveLength(7);
    expect(rows[0]!.isCurrent()).toBe(false);
    expect(rows[0]!.quota).toBeNull();
  });

  test("unsupported modes/destinations never fetch and capability does not need a key", async () => {
    const config = quotaKeyConfig();
    const provider = config.providers.openrouter!;
    delete provider.apiKey;
    expect(providerApiKeyQuotaMode("openrouter", provider)).toBe("probe");
    globalThis.fetch = (async () => { throw new Error("unexpected upstream"); }) as typeof globalThis.fetch;
    for (const authMode of ["oauth", "forward", "local"] as const) {
      provider.authMode = authMode;
      expect(providerApiKeyQuotaMode("openrouter", provider)).toBe("unsupported");
      expect(await fetchProviderApiKeyQuotas(config, "openrouter")).toEqual([]);
    }
    provider.authMode = "key";
    provider.baseUrl = "https://openrouter.example.invalid/api/v1";
    expect(providerApiKeyQuotaMode("openrouter", provider)).toBe("unsupported");
    expect(await fetchProviderApiKeyQuotas(config, "openrouter")).toEqual([]);
  });
});
