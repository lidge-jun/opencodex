import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { deriveOAuthProviderConfig, deriveProviderPresets } from "../../src/providers/derive";
import { OAUTH_PROVIDERS } from "../../src/oauth";
import { fetchDshAccountQuota } from "../../src/providers/quota/dsh-account";
import { AUTHORITATIVE_EMPTY_QUOTA, TERMINAL_QUOTA_FAILURE } from "../../src/providers/quota/report-cache";
import { SENSITIVE_KEY_PATTERN, redactSecretString } from "../../src/lib/redact";
import {
  DSH_ACCOUNT_MODELS,
  DSH_ACCOUNT_DEFAULT_MODEL,
  DSH_ACCOUNT_MODEL_CONTEXT_WINDOWS,
} from "../../src/providers/dsh-account-models";
import { saveConfig } from "../../src/config";
import { saveCredential, getAccountSet } from "../../src/oauth/store";
import { startServer } from "../../src/server";
import { stopServerListener } from "../../src/server/lifecycle";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { currentServerFixtureConfig } from "../helpers/server-auth-fixture";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { resolveAdapter, resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { credentialPinnedProviderConfigError, modelAdapterRecordConfigError } from "../../src/config/provider-validation";
import { resolveSidecarAuth } from "../../src/sidecar/auth";
import { buildLabProviderAuthHeaders } from "../../src/lib/lab-live-route-production";
import * as oauthIndex from "../../src/oauth";
import { loadConfig } from "../../src/config";
import { mayResolveModelsOAuth } from "../../src/oauth/model-discovery-auth";
import { resolveModelsAuthToken } from "../../src/oauth";
import { fetchProviderModels } from "../../src/codex/catalog/provider-models";
import { parseRequest } from "../../src/responses/parser";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// Runner timeouts do not finish a case's finally block before teardown starts.
// Keep listener ownership outside the case so teardown can release its spend lease.
const trackedServers = new Set<ReturnType<typeof startServer>>();

function startTrackedServer(): ReturnType<typeof startServer> {
  const server = startServer(0);
  trackedServers.add(server);
  return server;
}

async function removeDshFixtureHomes(...homes: string[]): Promise<void> {
  const stopFailures: unknown[] = [];
  for (const server of trackedServers) {
    trackedServers.delete(server);
    try { await stopServerListener(server); } catch (error) { stopFailures.push(error); }
  }
  if (stopFailures.length) throw new AggregateError(stopFailures, "DSH fixture server stop failed");
  await flushNativeMainStartupReleases();
  await flushConfigDirHardeningForTests();
  // Yield to in-process producers and reap Windows ACL children before removal.
  for (const home of homes) await removeTreeAfterBackgroundWork(home);
}

describe("dsh-account provider registry entry", () => {
  const entry = getProviderRegistryEntry("dsh-account");

  test("is registered with authKind: oauth and adapter: dsh-account", () => {
    expect(entry).toBeDefined();
    expect(entry?.authKind).toBe("oauth");
    expect(entry?.adapter).toBe("dsh-account");
    expect(entry?.oauthId).toBe("dsh-account");
    expect(entry?.label).toBe("DeepSeek Account (DSH)");
    expect(entry?.featured).toBe(false);
    expect(entry?.dashboardPreset).toBe(true);
  });

  test("defines authoritative static models from DSH upstream", () => {
    expect(entry?.models).toEqual([...DSH_ACCOUNT_MODELS]);
    expect(entry?.defaultModel).toBe(DSH_ACCOUNT_DEFAULT_MODEL);
    expect(entry?.liveModels).toBeFalsy();
    expect(entry?.modelContextWindows?.["deepseek-flash"]).toBe(1_000_000);
    expect(entry?.modelContextWindows?.["deepseek-v4-pro"]).toBe(1_000_000);
  });

  test("appears in derived provider presets as an account auth provider", () => {
    const presets = deriveProviderPresets();
    const preset = presets.find(p => p.id === "dsh-account");
    expect(preset).toBeDefined();
    expect(preset?.auth).toBe("oauth");
    expect(preset?.label).toBe("DeepSeek Account (DSH)");
  });

  test("is registered in OAUTH_PROVIDERS with disabled background refresh", () => {
    const oauthDef = OAUTH_PROVIDERS["dsh-account"];
    expect(oauthDef).toBeDefined();
    expect(oauthDef.defaultModel).toBe("deepseek-flash");
    expect(oauthDef.defaultRefreshPolicy).toBe("disabled");
  });
});

describe("dsh-account quota probe", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns AUTHORITATIVE_EMPTY_QUOTA on successful 200 get_user_summary with code 0", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v0/users/get_user_summary")) {
        capturedHeaders = init?.headers as Record<string, string>;
        const mockBody = {
          code: 0,
          data: {
            biz_code: 0,
            biz_data: {
              user_summary: {
                user_id: "user_456",
                email: "test@example.com",
                total_costs: [{ currency: "CNY", value: "32.50" }],
                normal_wallets: [{ currency: "CNY", balance: "100.00" }],
                bonus_wallets: [{ currency: "CNY", balance: "15.00" }],
              },
            },
          },
        };
        return new Response(JSON.stringify(mockBody), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    };

    const res = await fetchDshAccountQuota("dsh-account", "test-token");
    expect(capturedHeaders?.["x-dsh-auth-token"]).toBe("test-token");
    expect(res).toBe(AUTHORITATIVE_EMPTY_QUOTA);
  });

  test("returns AUTHORITATIVE_EMPTY_QUOTA on zero balance rather than fabricating 0% used quota", async () => {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v0/users/get_user_summary")) {
        const mockBody = {
          code: 0,
          data: {
            biz_code: 0,
            biz_data: {
              user_summary: {
                user_id: "user_empty",
                normal_wallets: [{ currency: "CNY", balance: "0.00" }],
                bonus_wallets: [{ currency: "CNY", balance: "0.00" }],
              },
            },
          },
        };
        return new Response(JSON.stringify(mockBody), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    };

    const res = await fetchDshAccountQuota("dsh-account", "test-token");
    expect(res).toBe(AUTHORITATIVE_EMPTY_QUOTA);
  });

  test("fails closed on redirect and does not leak token to redirect target", async () => {
    let evilReceivedToken = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/api/v0/users/get_user_summary")) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example.com/steal" },
        });
      }
      if (url.includes("evil.example.com")) {
        const headers = init?.headers as Record<string, string>;
        if (headers?.["x-dsh-auth-token"]) evilReceivedToken = true;
        return new Response("ok", { status: 200 });
      }
      return originalFetch(input, init);
    };

    const res = await fetchDshAccountQuota("dsh-account", "secret-token");
    expect(res).toBeNull();
    expect(evilReceivedToken).toBe(false);
  });

  test("returns TERMINAL_QUOTA_FAILURE on 401", async () => {
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
    const res = await fetchDshAccountQuota("dsh-account", "bad-token");
    expect(res).toBe(TERMINAL_QUOTA_FAILURE);
  });

  test("does not report authoritative account state for a failed business response", async () => {
    globalThis.fetch = async () => Response.json({ code: 0, data: { biz_code: 1, biz_data: { user_summary: {} } } });
    expect(await fetchDshAccountQuota("dsh-account", "mock-token")).toBeNull();
  });

  test("leaves quota unknown when a successful response omits account summary data", async () => {
    globalThis.fetch = async () => Response.json({ code: 0, data: { biz_code: 0 } });
    expect(await fetchDshAccountQuota("dsh-account", "mock-token")).toBeNull();
  });

  test("returns null on transient 500 error without failing credentials", async () => {
    globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });
    const res = await fetchDshAccountQuota("dsh-account", "token");
    expect(res).toBeNull();
  });
});

describe("dsh-account secret redaction", () => {
  test("x-dsh-auth-token matches SENSITIVE_KEY_PATTERN", () => {
    expect(SENSITIVE_KEY_PATTERN.test("x-dsh-auth-token")).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test("X-DSH-AUTH-TOKEN")).toBe(true);
  });

  test("redactSecretString masks x-dsh-auth-token values in strings", () => {
    const raw = "Request failed with header x-dsh-auth-token: secret_dsh_xyz789 on host";
    const redacted = redactSecretString(raw);
    expect(redacted).not.toContain("secret_dsh_xyz789");
    expect(redacted).toContain("[REDACTED]");
  });
});

describe("dsh-account 401 server/router lifecycle", () => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  const originalDshHome = process.env.DSH_HOME;
  let tmpHome: string;
  let tmpDsh: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ocx-dsh-lifecycle-home-"));
    tmpDsh = mkdtempSync(join(tmpdir(), "ocx-dsh-lifecycle-dsh-"));
    process.env.OPENCODEX_HOME = tmpHome;
    process.env.DSH_HOME = tmpDsh;

    // Create a mock ~/.dsh/.credentials.yaml with initial token
    writeFileSync(join(tmpDsh, ".credentials.yaml"), `records:
  deepseek-account-platform/default:
    kind: grant
    payload:
      token: dsh_desktop_local_token_123
`);
  });

  afterEach(async () => {
    try {
      await removeDshFixtureHomes(tmpHome, tmpDsh);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome !== undefined) process.env.OPENCODEX_HOME = originalHome;
      else delete process.env.OPENCODEX_HOME;
      if (originalDshHome !== undefined) process.env.DSH_HOME = originalDshHome;
      else delete process.env.DSH_HOME;
    }
  }, SERVER_BUDGET_MS);

  test("upstream 401 marks account needsReauth, blocks subsequent requests without fallback to deepseek API-key, and leaves credentials file untouched", async () => {
    // 1. Configure both dsh-account and deepseek (API-key)
    saveConfig(currentServerFixtureConfig({
      port: 0,
      hostname: "127.0.0.1",
      // Provider retirement does not exercise native Codex synchronization.
      clientIntegrations: { codex: false },
      defaultProvider: "dsh-account",
      providers: {
        "dsh-account": {
          adapter: "dsh-account",
          baseUrl: "https://api.deepseek.com",
          authMode: "oauth",
        },
        deepseek: {
          adapter: "openai-chat",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "sk-test-12345",
          authMode: "key",
        },
      },
    } as OcxConfig));

    // 2. Seed imported account into OpenCodeX auth store
    await saveCredential("dsh-account", {
      access: "dsh_desktop_local_token_123",
      refresh: "dsh_desktop_local_token_123",
      expires: Date.now() + 3_600_000,
      accountId: "dsh-account-user-001",
      source: "credential-file",
    });

    const credFileBefore = readFileSync(join(tmpDsh, ".credentials.yaml"), "utf8");

    // Track calls to endpoints
    let dshWireCalls = 0;
    let deepseekApiCalls = 0;

    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://api.deepseek.com/anthropic/v1/messages") {
        dshWireCalls += 1;
        expect(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-dsh-auth-token"))
          .toBe("dsh_desktop_local_token_123");
        // Upstream returns 401 token invalid
        return new Response(JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "Token expired or revoked" },
        }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://api.deepseek.com/v1/chat/completions") {
        deepseekApiCalls += 1;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      const destination = new URL(url);
      if (destination.protocol === "http:" && ["127.0.0.1", "localhost"].includes(destination.hostname)) {
        return originalFetch(input, init);
      }
      throw new Error("Unmocked external request in DSH lifecycle fixture");
    };

    const server = startTrackedServer();
    try {
      // 3. Send initial request for dsh-account/deepseek-flash
      const resp1 = await fetch(new URL("/v1/messages", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "dsh-account/deepseek-flash",
          max_tokens: 10,
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      // The request should fail with 401
      expect(resp1.status).toBe(401);
      expect(dshWireCalls).toBe(1);
      expect(deepseekApiCalls).toBe(0);

      // 4. Verify account became needsReauth
      const accountSet = getAccountSet("dsh-account");
      const account = accountSet?.accounts[0];
      expect(account).toBeDefined();
      expect(account?.needsReauth).toBe(true);

      // 5. Verify ~/.dsh/.credentials.yaml was completely untouched
      const credFileAfter = readFileSync(join(tmpDsh, ".credentials.yaml"), "utf8");
      expect(credFileAfter).toBe(credFileBefore);

      // Now change ~/.dsh/.credentials.yaml to have a different token (simulating user changing account in DSH Desktop)
      writeFileSync(join(tmpDsh, ".credentials.yaml"), `records:
  deepseek-account-platform/default:
    kind: grant
    payload:
      token: completely_different_user_token_999
`);

      // 6. Send second request to dsh-account/deepseek-flash
      const resp2 = await fetch(new URL("/v1/messages", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "dsh-account/deepseek-flash",
          max_tokens: 10,
          messages: [{ role: "user", content: "hello again" }],
        }),
      });

      // The second request must NOT use the needsReauth credential, must NOT silently auto-reimport,
      // and must NOT fallback to deepseek API-key
      expect(resp2.status).toBeGreaterThanOrEqual(400);
      expect(deepseekApiCalls).toBe(0); // Zero fallback to deepseek API-key!

      // Account must still be needsReauth (not silently cleared or re-imported)
      const currentAccount = getAccountSet("dsh-account")?.accounts[0];
      expect(currentAccount?.needsReauth).toBe(true);
      expect(currentAccount?.credential.access).toBe("dsh_desktop_local_token_123");
    } finally {
      await stopServerListener(server);
    }
  }, SERVER_BUDGET_MS); // Real auth-store ACL writes and listener startup exceed 5s on Windows.
});

describe("dsh-account wire pin keeps the account token on the DSH adapter", () => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ocx-dsh-wire-pin-home-"));
    process.env.OPENCODEX_HOME = tmpHome;
  });

  afterEach(async () => {
    try {
      await removeDshFixtureHomes(tmpHome);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome !== undefined) process.env.OPENCODEX_HOME = originalHome;
      else delete process.env.OPENCODEX_HOME;
    }
  }, SERVER_BUDGET_MS);

  test("config validation rejects a per-model wire override, even with a custom baseUrl", () => {
    for (const baseUrl of ["https://api.deepseek.com/anthropic", "https://evil.example/v1"]) {
      const error = modelAdapterRecordConfigError(
        { "deepseek-flash": "openai-chat" }, "modelAdapters", "dsh-account",
        { adapter: "dsh-account", authMode: "oauth", baseUrl },
      );
      expect(error).toContain("cannot be overridden");
    }
  });

  test("wire resolution forces the DSH adapter over row and per-model overrides", async () => {
    const hijacked = (baseUrl: string): OcxProviderConfig => ({
      adapter: "openai-chat",
      baseUrl,
      authMode: "oauth",
      apiKey: "dsh-pinned-token",
      modelAdapters: { "deepseek-flash": "openai-responses" },
    });
    const build = (baseUrl: string) => resolveAdapter(
      resolveWireProtocolOverride("dsh-account", "deepseek-flash", hijacked(baseUrl)), undefined, "dsh-account",
    ).buildRequest(
      parseRequest({ model: "deepseek-flash", input: [{ role: "user", content: "hi" }] }),
      { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    );
    for (const inbound of ["responses", "chat", "anthropic"] as const) {
      expect(resolveWireProtocolOverride("dsh-account", "deepseek-flash", hijacked("https://evil.example/v1"), inbound).adapter)
        .toBe("dsh-account");
    }
    const req = await build("https://api.deepseek.com");
    expect(req.url).toBe("https://api.deepseek.com/anthropic/v1/messages");
    expect(req.headers["x-dsh-auth-token"]).toBe("dsh-pinned-token");
    expect(Object.keys(req.headers).some(key => key.toLowerCase() === "authorization")).toBe(false);
    // Any other destination, including DeepSeek's own API-key path, fails closed before a request exists.
    for (const baseUrl of ["https://api.deepseek.com/v1", "https://evil.example/v1"]) {
      await expect(build(baseUrl)).rejects.toThrow("Untrusted dsh-account destination");
    }
  });

  test.each([
    "https://api.deepseek.com/v1",
    "https://evil.example/v1",
  ])("a hand-edited openai-chat row at %s is rejected at load and sends nothing", async (rowBaseUrl) => {
    saveConfig(currentServerFixtureConfig({
      port: 0,
      hostname: "127.0.0.1",
      clientIntegrations: { codex: false },
      defaultProvider: "dsh-account",
      providers: {
        "dsh-account": { adapter: "openai-chat", baseUrl: rowBaseUrl, authMode: "oauth" },
      },
    } as OcxConfig));
    await saveCredential("dsh-account", {
      access: "dsh_pinned_wire_token",
      refresh: "dsh_pinned_wire_token",
      expires: Date.now() + 3_600_000,
      accountId: "dsh-wire-pin-user",
      source: "credential-file",
    });
    const sends: { url: string; headers: Headers }[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost")) {
        sends.push({ url, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
        return new Response(JSON.stringify({
          id: "msg_pin", type: "message", role: "assistant", model: "deepseek-flash",
          content: [{ type: "text", text: "pinned" }], stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startTrackedServer();
    try {
      const resp = await fetch(new URL("/v1/messages", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "dsh-account/deepseek-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
      });
      await resp.text();
      expect(loadConfig().providers["dsh-account"]).toBeUndefined();
      expect(sends).toEqual([]);
    } finally {
      await stopServerListener(server);
    }
  }, SERVER_BUDGET_MS); // These two load-rejection cases also start a real listener.
});

describe("dsh-account token stays out of discovery and retires on a quota 401", () => {
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.OPENCODEX_HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ocx-dsh-discovery-home-"));
    process.env.OPENCODEX_HOME = tmpHome;
  });

  afterEach(async () => {
    try {
      await removeDshFixtureHomes(tmpHome);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome !== undefined) process.env.OPENCODEX_HOME = originalHome;
      else delete process.env.OPENCODEX_HOME;
    }
  });

  const seed = (access: string) => saveCredential("dsh-account", {
    access, refresh: access, expires: Date.now() + 3_600_000, accountId: "dsh-quota-user", source: "credential-file",
  });

  test("an edited Cursor row cannot resolve the DSH token for model discovery", async () => {
    await seed("dsh_discovery_token");
    const edited: OcxProviderConfig = { adapter: "cursor", baseUrl: "https://evil.example", authMode: "oauth" };
    const sends: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      sends.push(input instanceof Request ? input.url : String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    expect(mayResolveModelsOAuth("dsh-account", edited)).toBe(false);
    expect(await resolveModelsAuthToken("dsh-account", edited)).toBeUndefined();
    await fetchProviderModels("dsh-account", edited, 0);
    expect(sends).toEqual([]);
    expect(deriveOAuthProviderConfig("dsh-account")?.liveModels).toBe(false);
  });

  test("a quota 401 marks exactly the probed credential needsReauth", async () => {
    await seed("dsh_quota_rejected");
    const probed = getAccountSet("dsh-account")!.accounts[0]!;
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const result = await fetchDshAccountQuota("dsh-account", "dsh_quota_rejected", { accountId: probed.id, credential: probed.credential });
    expect(result).toBe(TERMINAL_QUOTA_FAILURE);
    expect(getAccountSet("dsh-account")!.accounts[0]!.needsReauth).toBe(true);
  });

  test("a quota 401 for a replaced credential leaves the re-imported one usable", async () => {
    await seed("dsh_quota_old");
    const stale = getAccountSet("dsh-account")!.accounts[0]!;
    await seed("dsh_quota_reimported");
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await fetchDshAccountQuota("dsh-account", "dsh_quota_old", { accountId: stale.id, credential: stale.credential });
    const current = getAccountSet("dsh-account")!.accounts[0]!;
    expect(current.credential.access).toBe("dsh_quota_reimported");
    expect(current.needsReauth).not.toBe(true);
  });
});

describe("dsh-account row stays pinned for every helper that resolves its token", () => {
  const originalHome = process.env.OPENCODEX_HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "ocx-dsh-row-pin-home-"));
    process.env.OPENCODEX_HOME = tmpHome;
  });

  afterEach(async () => {
    try {
      await removeDshFixtureHomes(tmpHome);
    } finally {
      if (originalHome !== undefined) process.env.OPENCODEX_HOME = originalHome;
      else delete process.env.OPENCODEX_HOME;
    }
  });

  test("validation accepts the canonical row and rejects an edited adapter or destination", () => {
    for (const baseUrl of ["https://api.deepseek.com/anthropic", "https://api.deepseek.com", undefined]) {
      expect(credentialPinnedProviderConfigError("dsh-account", { adapter: "dsh-account", baseUrl })).toBeNull();
    }
    for (const adapter of ["anthropic", "cursor", "openai-chat", "openai-responses"]) {
      expect(credentialPinnedProviderConfigError("dsh-account", { adapter, baseUrl: "https://api.deepseek.com/anthropic" }))
        .toContain("adapter must stay");
    }
    for (const baseUrl of ["https://evil.example", "https://api.deepseek.com/v1", "http://api.deepseek.com/anthropic"]) {
      expect(credentialPinnedProviderConfigError("dsh-account", { adapter: "dsh-account", baseUrl })).toContain("baseUrl must stay");
    }
    // Other providers are untouched, including an Anthropic row at a custom gateway.
    expect(credentialPinnedProviderConfigError("anthropic", { adapter: "anthropic", baseUrl: "https://evil.example" })).toBeNull();
  });

  test("Anthropic helpers never select a dsh-account row, even one edited onto the anthropic adapter", async () => {
    await saveCredential("dsh-account", {
      access: "dsh_helper_token", refresh: "dsh_helper_token", expires: Date.now() + 3_600_000,
      accountId: "dsh-helper-user", source: "credential-file",
    });
    const auth = resolveSidecarAuth({
      providers: { "dsh-account": { adapter: "anthropic", authMode: "oauth", baseUrl: "https://evil.example" } },
    } as unknown as OcxConfig);
    expect(auth.isAnthropicAuth).toBe(false);
    expect(auth.anthropicProviderName).toBeUndefined();
  });

  test("Compatibility Lab refuses dsh-account before resolving its token", async () => {
    const snapshot = spyOn(oauthIndex, "getValidAccessTokenSnapshot");
    try {
      for (const baseUrl of ["https://api.deepseek.com/anthropic", "https://evil.example"]) {
        const config = { providers: { "dsh-account": { adapter: "dsh-account", authMode: "oauth", baseUrl } } } as unknown as OcxConfig;
        await expect(buildLabProviderAuthHeaders({ providerId: "dsh-account", baseUrl } as never, config))
          .rejects.toMatchObject({ message: expect.stringContaining("dsh-account probes are not supported") });
      }
      expect(snapshot).not.toHaveBeenCalled();
    } finally {
      snapshot.mockRestore();
    }
  });
});
