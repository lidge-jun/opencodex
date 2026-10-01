import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { deriveProviderPresets } from "../../src/providers/derive";
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
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

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
    globalThis.fetch = originalFetch;
    if (originalHome !== undefined) process.env.OPENCODEX_HOME = originalHome;
    else delete process.env.OPENCODEX_HOME;
    if (originalDshHome !== undefined) process.env.DSH_HOME = originalDshHome;
    else delete process.env.DSH_HOME;
    removeTreeWithRetry(tmpHome);
    removeTreeWithRetry(tmpDsh);
  });

  test("upstream 401 marks account needsReauth, blocks subsequent requests without fallback to deepseek API-key, and leaves credentials file untouched", async () => {
    // 1. Configure both dsh-account and deepseek (API-key)
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
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
    } as OcxConfig);

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
      const url = String(input);
      if (url.includes("/anthropic/v1/messages")) {
        dshWireCalls += 1;
        // Upstream returns 401 token invalid
        return new Response(JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "Token expired or revoked" },
        }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v1/chat/completions")) {
        deepseekApiCalls += 1;
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }
      return originalFetch(input, init);
    };

    const server = startServer(0);
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
      await server.stop(true);
    }
  });
});
