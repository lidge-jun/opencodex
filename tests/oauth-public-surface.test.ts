import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  isOAuthProvider,
  isPublicOAuthProvider,
  listOAuthProviders,
  OAUTH_PROVIDERS,
  runLogin,
  upsertOAuthProvider,
} from "../src/oauth";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import type { OAuthController } from "../src/oauth/types";
import { getCredential } from "../src/oauth/store";

const TEST_DIR = join(import.meta.dir, ".tmp-oauth-public-surface");
const previousHome = process.env.OPENCODEX_HOME;
const canonical = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward" as const,
};

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: { openai: { ...canonical, codexAccountMode: "pool" } },
  };
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("legacy ChatGPT OAuth public-surface exclusion", () => {
  test("keeps low-level compatibility but excludes public discovery", () => {
    expect(isOAuthProvider("chatgpt")).toBe(true);
    expect(isPublicOAuthProvider("chatgpt")).toBe(false);
    expect(listOAuthProviders()).not.toContain("chatgpt");
    expect(listOAuthProviders()).toContain("xai");
  });

  test("generic management OAuth endpoints reject chatgpt before touching login state", async () => {
    const cfg = config();
    const requests = [
      new Request("http://localhost/api/oauth/login", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "chatgpt" }),
      }),
      new Request("http://localhost/api/oauth/login/code", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "chatgpt", input: "code" }),
      }),
      new Request("http://localhost/api/oauth/status?provider=chatgpt"),
      new Request("http://localhost/api/oauth/logout?provider=chatgpt", { method: "POST" }),
      new Request("http://localhost/api/oauth/accounts?provider=chatgpt"),
      new Request("http://localhost/api/oauth/accounts/active", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "chatgpt", accountId: "a" }),
      }),
      new Request("http://localhost/api/oauth/accounts?provider=chatgpt&id=a", { method: "DELETE" }),
    ];
    for (const req of requests) {
      const response = await handleManagementAPI(req, new URL(req.url), cfg);
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({ error: "unknown oauth provider" });
    }
    const discoveryReq = new Request("http://localhost/api/oauth/providers");
    const discovery = await handleManagementAPI(discoveryReq, new URL(discoveryReq.url), cfg);
    expect((await discovery?.json() as { providers: string[] }).providers).not.toContain("chatgpt");
  });

  test("internal chatgpt login persists credentials without creating a fourth provider", async () => {
    const cfg = config();
    upsertOAuthProvider(cfg, "chatgpt");
    expect(cfg.providers.chatgpt).toBeUndefined();

    const originalLogin = OAUTH_PROVIDERS.chatgpt.login;
    OAUTH_PROVIDERS.chatgpt.login = async () => ({
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: Date.now() + 60_000,
    });
    try {
      await runLogin("chatgpt", {} as OAuthController);
    } finally {
      OAUTH_PROVIDERS.chatgpt.login = originalLogin;
    }
    expect(getCredential("chatgpt")?.access).toBe("legacy-access");
    expect(cfg.providers.chatgpt).toBeUndefined();
  });
});
