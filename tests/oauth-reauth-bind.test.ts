import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OAUTH_PROVIDERS, runLogin } from "../src/oauth";
import { getAccountCredential, getAccountSet, saveCredential } from "../src/oauth/store";
import type { OAuthController } from "../src/oauth/types";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, ".tmp-oauth-reauth-bind");
const previousHome = process.env.OPENCODEX_HOME;

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      xai: {
        adapter: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
        authMode: "oauth",
      },
    },
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

describe("OAuth account-scoped reauth", () => {
  test("POST /api/oauth/login rejects unknown accountId", async () => {
    const cfg = config();
    const req = new Request("http://localhost/api/oauth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "xai", accountId: "missing-slot", reauth: true }),
    });
    const resp = await handleManagementAPI(req, new URL(req.url), cfg);
    expect(resp?.status).toBe(404);
    expect(await resp?.json()).toEqual({ error: "Unknown account for reauth" });
  });

  test("runLogin reauthAccountId refuses identity mismatch", async () => {
    await saveCredential("xai", {
      access: "a1",
      refresh: "r1",
      expires: Date.now() + 60_000,
      email: "slot-a@example.test",
      accountId: "acct-a",
    });
    const slotId = getAccountSet("xai")!.activeAccountId;
    const original = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async () => ({
      access: "a2",
      refresh: "r2",
      expires: Date.now() + 60_000,
      email: "other@example.test",
      accountId: "acct-other",
    });
    try {
      await expect(runLogin("xai", {} as OAuthController, { reauthAccountId: slotId })).rejects.toThrow(
        /does not match the selected account/,
      );
    } finally {
      OAUTH_PROVIDERS.xai.login = original;
    }
    expect(getAccountCredential("xai", slotId)?.access).toBe("a1");
  });

  test("runLogin reauthAccountId refreshes the same slot on identity match", async () => {
    await saveCredential("xai", {
      access: "a1",
      refresh: "r1",
      expires: Date.now() + 60_000,
      email: "slot-a@example.test",
      accountId: "acct-a",
    });
    const slotId = getAccountSet("xai")!.activeAccountId;
    const original = OAUTH_PROVIDERS.xai.login;
    OAUTH_PROVIDERS.xai.login = async () => ({
      access: "a2",
      refresh: "r2",
      expires: Date.now() + 60_000,
      email: "slot-a@example.test",
      accountId: "acct-a",
    });
    try {
      await runLogin("xai", {} as OAuthController, { reauthAccountId: slotId });
    } finally {
      OAUTH_PROVIDERS.xai.login = original;
    }
    expect(getAccountCredential("xai", slotId)?.access).toBe("a2");
    expect(getAccountSet("xai")?.accounts).toHaveLength(1);
  });

  test("management login passes reauthAccountId into startLoginFlow", async () => {
    const source = await Bun.file("src/server/management-api.ts").text();
    expect(source).toContain("reauthAccountId: accountId");
    expect(source).toContain("Unknown account for reauth");
  });
});
