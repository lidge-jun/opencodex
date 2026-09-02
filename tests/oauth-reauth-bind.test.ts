import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync} from "node:fs";
import { join } from "node:path";
import { OAUTH_PROVIDERS, runLogin } from "../src/oauth";
import { getAccountCredential, getAccountSet, saveCredential } from "../src/oauth/store";
import type { OAuthController, OAuthCredentials } from "../src/oauth/types";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import { flushConfigDirHardeningForTests } from "../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../src/lib/windows-secret-acl";

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

// No server runs here, so nothing drains the OAuth store's hardenConfigDir() flight before
// teardown; on windows-latest the icacls child outlived the 2.45 s retry (run 33610501053).
// The file tests reauth binding, not ACLs: stub both runners and flush.
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

beforeEach(() => {
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(async () => {
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(TEST_DIR);
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

  test("forced Kiro add-account preserves a legacy identity-less account", async () => {
    await saveCredential("kiro", {
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: Date.now() + 60_000,
      source: "local-cli",
    });
    const original = OAUTH_PROVIDERS.kiro.login;
    OAUTH_PROVIDERS.kiro.login = async () => ({
      access: "identified-access",
      refresh: "identified-refresh",
      expires: Date.now() + 60_000,
      accountId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/new",
      source: "local-cli",
    });
    try {
      await runLogin("kiro", {} as OAuthController, { forceLogin: true });
    } finally {
      OAUTH_PROVIDERS.kiro.login = original;
    }

    const set = getAccountSet("kiro")!;
    expect(set.accounts).toHaveLength(2);
    expect(set.accounts.some(account => account.credential.access === "legacy-access")).toBe(true);
    expect(getAccountCredential("kiro", set.activeAccountId)?.access).toBe("identified-access");
  });

  test("forced Kimi add-account preserves a legacy identity-less account", async () => {
    await saveCredential("kimi", {
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: Date.now() + 60_000,
    });
    const legacySlotId = getAccountSet("kimi")!.activeAccountId;
    const original = OAUTH_PROVIDERS.kimi.login;
    OAUTH_PROVIDERS.kimi.login = async () => ({
      access: "identified-access",
      refresh: "identified-refresh",
      expires: Date.now() + 60_000,
      accountId: "new-kimi-user",
    });
    try {
      await runLogin("kimi", {} as OAuthController, { forceLogin: true });
    } finally {
      OAUTH_PROVIDERS.kimi.login = original;
    }

    const set = getAccountSet("kimi")!;
    expect(set.accounts).toHaveLength(2);
    expect(set.activeAccountId).not.toBe(legacySlotId);
    expect(getAccountCredential("kimi", legacySlotId)).toMatchObject({
      access: "legacy-access",
      refresh: "legacy-refresh",
    });
    expect(getAccountCredential("kimi", set.activeAccountId)).toMatchObject({
      access: "identified-access",
      accountId: "new-kimi-user",
    });
  });

  test("forced Kimi add-account also preserves the legacy slot for opaque tokens", async () => {
    await saveCredential("kimi", {
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: Date.now() + 60_000,
    });
    const legacySlotId = getAccountSet("kimi")!.activeAccountId;
    const original = OAUTH_PROVIDERS.kimi.login;
    OAUTH_PROVIDERS.kimi.login = async () => ({
      access: "opaque-new-access",
      refresh: "opaque-new-refresh",
      expires: Date.now() + 60_000,
    });
    try {
      await runLogin("kimi", {} as OAuthController, { forceLogin: true });
    } finally {
      OAUTH_PROVIDERS.kimi.login = original;
    }

    const set = getAccountSet("kimi")!;
    expect(set.accounts).toHaveLength(2);
    expect(set.activeAccountId).not.toBe(legacySlotId);
    expect(getAccountCredential("kimi", legacySlotId)).toMatchObject({
      access: "legacy-access",
      refresh: "legacy-refresh",
    });
    expect(getAccountCredential("kimi", set.activeAccountId)).toMatchObject({
      access: "opaque-new-access",
      refresh: "opaque-new-refresh",
    });
  });

  test("non-force Kimi login upgrades the legacy identity-less slot in place", async () => {
    await saveCredential("kimi", {
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: Date.now() + 60_000,
    });
    const legacySlotId = getAccountSet("kimi")!.activeAccountId;
    const original = OAUTH_PROVIDERS.kimi.login;
    OAUTH_PROVIDERS.kimi.login = async () => ({
      access: "identified-access",
      refresh: "identified-refresh",
      expires: Date.now() + 60_000,
      accountId: "existing-kimi-user",
    });
    try {
      await runLogin("kimi", {} as OAuthController);
    } finally {
      OAUTH_PROVIDERS.kimi.login = original;
    }

    const set = getAccountSet("kimi")!;
    expect(set.accounts).toHaveLength(1);
    expect(set.activeAccountId).toBe(legacySlotId);
    expect(getAccountCredential("kimi", legacySlotId)).toMatchObject({
      access: "identified-access",
      refresh: "identified-refresh",
      accountId: "existing-kimi-user",
    });
  });

  test("non-force Kiro login upgrades a legacy identity-less slot in place", async () => {
    await saveCredential("kiro", {
      access: "legacy-access",
      refresh: "legacy-refresh",
      expires: Date.now() + 60_000,
      source: "local-cli",
    });
    const legacySlotId = getAccountSet("kiro")!.activeAccountId;
    const original = OAUTH_PROVIDERS.kiro.login;
    OAUTH_PROVIDERS.kiro.login = async () => ({
      access: "identified-access",
      refresh: "identified-refresh",
      expires: Date.now() + 60_000,
      accountId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/existing",
      source: "local-cli",
    });
    try {
      await runLogin("kiro", {} as OAuthController);
    } finally {
      OAUTH_PROVIDERS.kiro.login = original;
    }

    const set = getAccountSet("kiro")!;
    expect(set.accounts).toHaveLength(1);
    expect(set.activeAccountId).toBe(legacySlotId);
    expect(getAccountCredential("kiro", legacySlotId)?.access).toBe("identified-access");
  });

  test("runLogin settles a source-less Kiro credential with its exact raw object identity", async () => {
    const rawCredential: OAuthCredentials = {
      access: "source-less-access",
      refresh: "source-less-refresh",
      expires: Date.now() + 60_000,
      accountId: "arn:aws:codewhisperer:us-east-1:123456789012:profile/source-less",
    };
    let savedCredential: OAuthCredentials | undefined;
    let settledCredential: OAuthCredentials | undefined;
    let settledPersisted: boolean | undefined;
    const original = OAUTH_PROVIDERS.kiro.login;
    OAUTH_PROVIDERS.kiro.login = async () => rawCredential;
    try {
      await runLogin("kiro", {} as OAuthController, undefined, {
        saveCredential: async (_provider, credential) => { savedCredential = credential; },
        settleKiroLoginTransaction: (credential, persisted) => {
          settledCredential = credential;
          settledPersisted = persisted;
        },
      });
    } finally {
      OAUTH_PROVIDERS.kiro.login = original;
    }

    expect(savedCredential).not.toBe(rawCredential);
    expect(savedCredential?.source).toBe("oauth");
    expect(settledCredential).toBe(rawCredential);
    expect(settledPersisted).toBe(true);
  });

  test("management login passes reauthAccountId into startLoginFlow", async () => {
    const source = await Bun.file("src/server/management/oauth-account-routes.ts").text();
    expect(source).toContain("reauthAccountId: accountId");
    expect(source).toContain("Unknown account for reauth");
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
