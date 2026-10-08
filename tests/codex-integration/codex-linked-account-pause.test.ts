import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { loadConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { handleCodexAuthAPI, clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { getCodexAccountCredential, saveCodexAccountCredential } from "../../src/codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "../../src/codex/main-account";
import { clearCodexUpstreamHealth, clearThreadAccountMap, resolveCodexAccountForThread } from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { pinnedCodexAccountId, setCodexAccountPin } from "../../src/codex/account-priority";
import { acquireNativeMainProfileDrain, resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { withNativeMainExclusiveClaim } from "../../src/codex/native-main-claim";
import { MAX_AUTH_BYTES, resolveNativeProfileContext } from "../../src/codex/native-profile-store";

let TEST_DIR: string;
let TEST_CODEX_HOME: string;
let previousHome: string | undefined;
let previousCodexHome: string | undefined;
const aclOk = { success: true, exitCode: 0, timedOut: false, stdout: "" };

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", codexAccounts: [], ...overrides };
}

function seedPoolAccount(config: OcxConfig, account: { id: string; email: string; chatgptAccountId?: string }): void {
  config.codexAccounts!.push({ id: account.id, email: account.email, isMain: false });
  saveCodexAccountCredential(account.id, {
    accessToken: `access-${account.id}`, refreshToken: `refresh-${account.id}`,
    expiresAt: Date.now() + 300_000, chatgptAccountId: account.chatgptAccountId ?? `acct-${account.id}`,
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-linked-pause-"));
  TEST_CODEX_HOME = join(TEST_DIR, "codex");
  mkdirSync(TEST_CODEX_HOME);
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_CODEX_HOME;
  setIcaclsRunnerForTests(() => aclOk);
  setAsyncIcaclsRunnerForTests(async () => aclOk);
  resetLifecycleDrainStateForTests();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearPoolRotationState();
  clearAccountQuota();
  setMainAccountPlan(null);
});

afterEach(async () => {
  resetLifecycleDrainStateForTests();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearPoolRotationState();
  clearAccountQuota();
  setMainAccountPlan(null);
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(TEST_DIR);
});

for (const selectedId of [MAIN_CODEX_ACCOUNT_ID, "same-login"]) {
  test(`manual pause links main and pool identity from ${selectedId}`, async () => {
    const config = makeConfig({ activeCodexAccountId: "same-login" });
    const idToken = `header.${Buffer.from(JSON.stringify({
      email: "SAME@example.test", chatgpt_account_id: "personal-scope",
    })).toString("base64url")}.signature`;
    const auth = JSON.stringify({ tokens: {
      access_token: "main-linked-access", account_id: "personal-scope", id_token: idToken,
    } });
    writeFileSync(join(TEST_CODEX_HOME, "auth.json"), auth);
    seedPoolAccount(config, { id: "same-login", email: " same@example.test ", chatgptAccountId: "personal-scope" });
    seedPoolAccount(config, { id: "other-workspace", email: "same@example.test", chatgptAccountId: "team-scope" });
    seedPoolAccount(config, { id: "other-member", email: "other@example.test", chatgptAccountId: "personal-scope" });
    updateAccountQuota("same-login", 1);
    updateAccountQuota("other-workspace", 10);
    updateAccountQuota("other-member", 20);
    setCodexAccountPin(config, "same-login");
    expect(resolveCodexAccountForThread("linked-existing-thread", config)).toBe("same-login");

    const changePause = async (id: string, paused: boolean) => {
      const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, paused }),
      });
      const response = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(response!.status).toBe(200);
      return response!.json();
    };
    const result = await changePause(selectedId, true);
    expect(resolveCodexAccountForThread("linked-existing-thread", config)).toBe("other-workspace");
    expect(resolveCodexAccountForThread("linked-new-thread", config)).toBe("other-workspace");
    expect(new Set(config.pausedCodexAccountIds)).toEqual(new Set([MAIN_CODEX_ACCOUNT_ID, "same-login"]));
    expect(new Set(result.affectedAccountIds)).toEqual(new Set([MAIN_CODEX_ACCOUNT_ID, "same-login"]));
    expect(new Set(loadConfig().pausedCodexAccountIds)).toEqual(new Set(config.pausedCodexAccountIds));
    expect(pinnedCodexAccountId(config)).toBeUndefined();
    expect(readFileSync(join(TEST_CODEX_HOME, "auth.json"), "utf8")).toBe(auth);
    expect(getCodexAccountCredential("same-login")?.accessToken).toBe("access-same-login");

    // Resume through the other card, preserving pauses belonging to unrelated identities.
    config.pausedCodexAccountIds!.push("other-member");
    await changePause(selectedId === MAIN_CODEX_ACCOUNT_ID ? "same-login" : MAIN_CODEX_ACCOUNT_ID, false);
    expect(config.pausedCodexAccountIds).toEqual(["other-member"]);
    expect(loadConfig().pausedCodexAccountIds).toEqual(["other-member"]);
  });
}

test("manual pause cannot publish a partial identity group while native main is draining", async () => {
  const config = makeConfig();
  seedPoolAccount(config, { id: "pause-drain", email: "drain@example.test" });
  const drain = acquireNativeMainProfileDrain("linked-pause-test");
  try {
    const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pause-drain", paused: true }),
    });
    const response = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(response!.status).toBe(503);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(existsSync(join(TEST_DIR, "config.json"))).toBe(false);
  } finally {
    drain.release();
  }
});

test("manual pause does not link a main login whose email identity is unknown", async () => {
  const config = makeConfig();
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
    tokens: { access_token: "opaque-main", account_id: "shared-workspace" },
  }));
  seedPoolAccount(config, { id: "known-member", email: "member@example.test", chatgptAccountId: "shared-workspace" });
  const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "known-member", paused: true }),
  });
  const response = await handleCodexAuthAPI(req, new URL(req.url), config);
  expect(response!.status).toBe(200);
  expect(config.pausedCodexAccountIds).toEqual(["known-member"]);
});

test("manual pause refuses an unreadable main identity without changing pause state", async () => {
  const config = makeConfig();
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), "invalid-json");
  seedPoolAccount(config, { id: "pause-invalid", email: "invalid@example.test" });
  const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "pause-invalid", paused: true }),
  });
  const response = await handleCodexAuthAPI(req, new URL(req.url), config);
  expect(response!.status).toBe(503);
  expect(config.pausedCodexAccountIds).toBeUndefined();
});

test("manual pause respects the cross-process native-main switch claim", async () => {
  const config = makeConfig();
  seedPoolAccount(config, { id: "pause-exclusive", email: "exclusive@example.test" });
  await withNativeMainExclusiveClaim(resolveNativeProfileContext(), async () => {
    const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pause-exclusive", paused: true }),
    });
    const response = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(response!.status).toBe(503);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(existsSync(join(TEST_DIR, "config.json"))).toBe(false);
  });
});

test("manual pause refuses conflicting native-main workspace claims", async () => {
  const config = makeConfig();
  const idToken = `header.${Buffer.from(JSON.stringify({
    email: "same@example.test", chatgpt_account_id: "different-scope",
  })).toString("base64url")}.signature`;
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
    tokens: { access_token: "opaque-main", account_id: "wire-scope", id_token: idToken },
  }));
  seedPoolAccount(config, { id: "pause-conflict", email: "same@example.test", chatgptAccountId: "different-scope" });
  const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "pause-conflict", paused: true }),
  });
  const response = await handleCodexAuthAPI(req, new URL(req.url), config);
  expect(response!.status).toBe(503);
  expect(config.pausedCodexAccountIds).toBeUndefined();
});

test("manual pause refuses main tokens that name different members of one workspace", async () => {
  const config = makeConfig();
  const token = (email: string) => `header.${Buffer.from(JSON.stringify({
    email, chatgpt_account_id: "shared-scope",
  })).toString("base64url")}.signature`;
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
    tokens: { access_token: token("bob@example.test"), account_id: "shared-scope", id_token: token("alice@example.test") },
  }));
  seedPoolAccount(config, { id: "alice-login", email: "alice@example.test", chatgptAccountId: "shared-scope" });
  const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "alice-login", paused: true }),
  });
  const response = await handleCodexAuthAPI(req, new URL(req.url), config);
  expect(response!.status).toBe(503);
  expect(config.pausedCodexAccountIds).toBeUndefined();
});

test("manual pause matches the selected workspace instead of the first organization membership", async () => {
  const config = makeConfig();
  const idToken = `header.${Buffer.from(JSON.stringify({
    email: "same@example.test", organizations: [{ id: "other-membership" }],
  })).toString("base64url")}.signature`;
  writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
    tokens: { access_token: "opaque-main", account_id: "selected-workspace", id_token: idToken },
  }));
  seedPoolAccount(config, { id: "selected-login", email: "same@example.test", chatgptAccountId: "selected-workspace" });
  const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: MAIN_CODEX_ACCOUNT_ID, paused: true }),
  });
  const response = await handleCodexAuthAPI(req, new URL(req.url), config);
  expect(response!.status).toBe(200);
  expect(new Set(config.pausedCodexAccountIds)).toEqual(new Set([MAIN_CODEX_ACCOUNT_ID, "selected-login"]));
});

for (const mainState of ["missing-home", "api-key-only", "api-key-null-tokens"] as const) {
  test(`manual pause and resume group Pool-only identities with ${mainState}`, async () => {
    const config = makeConfig();
    if (mainState === "missing-home") {
      process.env.CODEX_HOME = join(TEST_DIR, "absent-codex-home");
    } else {
      writeFileSync(join(TEST_CODEX_HOME, "auth.json"), JSON.stringify({
        OPENAI_API_KEY: "test-only-api-key",
        ...(mainState === "api-key-null-tokens" ? { auth_mode: "api_key", tokens: null } : {}),
      }));
    }
    seedPoolAccount(config, { id: "pool-only", email: "same@example.test", chatgptAccountId: "pool-scope" });
    seedPoolAccount(config, { id: "pool-copy", email: "SAME@example.test", chatgptAccountId: "pool-scope" });
    seedPoolAccount(config, { id: "pool-other", email: "same@example.test", chatgptAccountId: "other-scope" });
    for (const paused of [true, false]) {
      const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "pool-only", paused }),
      });
      const response = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(response!.status).toBe(200);
      expect(new Set((await response!.json()).affectedAccountIds)).toEqual(new Set(["pool-only", "pool-copy"]));
      expect(new Set(config.pausedCodexAccountIds)).toEqual(new Set(paused ? ["pool-only", "pool-copy"] : []));
      expect(loadConfig().pausedCodexAccountIds).toEqual(config.pausedCodexAccountIds);
    }
    // Main remains addressable by id but has no identity to link to the Pool.
    const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: MAIN_CODEX_ACCOUNT_ID, paused: true }),
    });
    const response = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(response!.status).toBe(200);
    expect((await response!.json()).affectedAccountIds).toEqual([MAIN_CODEX_ACCOUNT_ID]);
    expect(config.pausedCodexAccountIds).toEqual([MAIN_CODEX_ACCOUNT_ID]);
    if (mainState === "missing-home") expect(existsSync(process.env.CODEX_HOME!)).toBe(false);
  });
}

for (const mainState of ["oversized", "directory", "invalid-home", "api-key-malformed-tokens", "api-key-chatgpt-mode"] as const) {
  test(`manual pause rejects ${mainState} before publication`, async () => {
    const config = makeConfig({ activeCodexAccountId: "pause-unsafe" });
    seedPoolAccount(config, { id: "pause-unsafe", email: "unsafe@example.test" });
    setCodexAccountPin(config, "pause-unsafe");
    const before = JSON.stringify(config);
    const authPath = join(TEST_CODEX_HOME, "auth.json");
    if (mainState === "directory") mkdirSync(authPath);
    else if (mainState === "invalid-home") {
      const homePath = join(TEST_DIR, "non-directory-home");
      writeFileSync(homePath, "not-a-directory");
      process.env.CODEX_HOME = homePath;
    } else if (mainState === "oversized") {
      // Valid ChatGPT JSON would succeed with the old unbounded reader.
      writeFileSync(authPath, JSON.stringify({
        tokens: { access_token: "opaque-main", account_id: "main-scope" },
        padding: " ".repeat(MAX_AUTH_BYTES),
      }));
    } else {
      writeFileSync(authPath, JSON.stringify({
        OPENAI_API_KEY: "test-only-api-key",
        ...(mainState === "api-key-malformed-tokens" ? { tokens: {} } : { auth_mode: "chatgpt" }),
      }));
    }
    const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pause-unsafe", paused: true }),
    });
    const response = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(response!.status).toBe(503);
    expect(response!.headers.get("Retry-After")).toBe("1");
    expect(JSON.stringify(config)).toBe(before);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(pinnedCodexAccountId(config)).toBe("pause-unsafe");
    expect(existsSync(join(TEST_DIR, "config.json"))).toBe(false);
  });
}

test("Pool-only pause with an absent home still respects native-main admission", async () => {
  process.env.CODEX_HOME = join(TEST_DIR, "absent-codex-home");
  const config = makeConfig();
  seedPoolAccount(config, { id: "absent-drain", email: "drain@example.test" });
  const drain = acquireNativeMainProfileDrain("absent-home-pause-test");
  try {
    const req = new Request("http://localhost/api/codex-auth/accounts/pause", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "absent-drain", paused: true }),
    });
    const response = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(response!.status).toBe(503);
    expect(config.pausedCodexAccountIds).toBeUndefined();
    expect(existsSync(join(TEST_DIR, "config.json"))).toBe(false);
  } finally {
    drain.release();
  }
});
