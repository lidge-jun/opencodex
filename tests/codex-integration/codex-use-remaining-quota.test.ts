import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { getEffectiveCodexAutoSwitchThreshold } from "../../src/codex/account-auto-switch";
import { setCodexAccountUseRemainingQuota } from "../../src/codex/account-use-remaining";
import { getMainAccountHardLockStatus } from "../../src/codex/main-account-hard-lock";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap, recordCodexUpstreamOutcome, resolveCodexAccountForThread } from "../../src/codex/routing";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { deleteCodexAccount } from "../../src/codex/account-lifecycle";
import { handleCodexAuthAPI } from "../../src/codex/auth-api";
import { configSchema } from "../../src/config/schema/config-schema";
import { validateConfigCandidate } from "../../src/config/diagnostics";
import { requireManagementAuth, type ManagementAuthState } from "../../src/server/management-auth";
import * as configModule from "../../src/config";
import { setIcaclsRunnerForTests, setAsyncIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import type { OcxConfig } from "../../src/types";

let home: TempHome;
const acl = { success: true, exitCode: 0, timedOut: false, stdout: "" };
beforeEach(() => {
  home = createTempHome("ocx-use-remaining-");
  setIcaclsRunnerForTests(() => acl); setAsyncIcaclsRunnerForTests(async () => acl);
  clearAccountQuota(); clearMainAccountInfoCache(); clearCodexUpstreamHealth(); clearThreadAccountMap();
});
afterEach(async () => {
  clearAccountQuota(); clearMainAccountInfoCache(); clearCodexUpstreamHealth(); clearThreadAccountMap();
  await flushConfigDirHardeningForTests();
  setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null); home.remove();
});
function config(): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: { openai: {
    adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward", codexAccountMode: "pool",
  } }, autoSwitchThreshold: 95,
    codexAccounts: ["a", "b"].map(id => ({ id, email: id + "@example.test", isMain: false })),
    activeCodexAccountId: "a", codexAccountAutoSwitchThresholds: { a: 90 },
    codexMainAccountHardLockThresholds: { short: 90, long: 95 } };
}
async function request(cfg: OcxConfig, body: unknown, method = "PUT") {
  const url = new URL("http://localhost/api/codex-auth/accounts/use-remaining" + (method === "GET" ? "?id=a" : ""));
  return (await handleCodexAuthAPI(new Request(url, { method, ...(method === "GET" ? {} : {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) }), url, cfg))!;
}
function credentials() {
  for (const id of ["a", "b"]) saveCodexAccountCredential(id, {
    accessToken: "fixture-access-" + id, refreshToken: "fixture-refresh-" + id,
    expiresAt: Date.now() + 3600_000, chatgptAccountId: "fixture-account-" + id,
  });
}
function observeMain(percent: number, short = false) {
  observeMainQuotaIdentity("remaining-main");
  setAccountQuotaFromParsed("__main__", short ? { shortPercent: percent } : { weeklyPercent: percent },
    undefined, captureMainQuotaWriter("remaining-main"));
}

test("main admits 95 and 99.9 percent only after explicit opt-in, then blocks at 100", () => {
  const cfg = config();
  observeMain(95);
  expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  setCodexAccountUseRemainingQuota(cfg, "__main__", true);
  expect(getMainAccountHardLockStatus(cfg)).toMatchObject({ enabled: true, state: "ready", thresholds: { short: 100, long: 100 } });
  observeMain(99.9);
  expect(getMainAccountHardLockStatus(cfg).state).toBe("ready");
  observeMain(100);
  expect(getMainAccountHardLockStatus(cfg).state).toBe("blocked");
  expect(cfg.codexMainAccountHardLock).toBeUndefined();
  expect(cfg.creditCodexAccountIds).toBeUndefined();
});

test("short-window protection also moves to 100 and disabling restores configured values", () => {
  const cfg = config();
  observeMain(95, true);
  setCodexAccountUseRemainingQuota(cfg, "__main__", true);
  expect(getMainAccountHardLockStatus(cfg).state).toBe("ready");
  setCodexAccountUseRemainingQuota(cfg, "__main__", false);
  expect(getMainAccountHardLockStatus(cfg)).toMatchObject({ state: "blocked", thresholds: { short: 90, long: 95 } });
  expect(cfg.codexUseRemainingQuotaAccountIds).toBeUndefined();
});

test("manual account continues at 95 with a cooler alternative, but not while paused or cooled", () => {
  const cfg = config(); credentials();
  updateAccountQuota("a", 95); updateAccountQuota("b", 5);
  expect(resolveCodexAccountForThread("before", cfg)).toBe("b");
  cfg.activeCodexAccountId = "a";
  setCodexAccountUseRemainingQuota(cfg, "a", true);
  expect(resolveCodexAccountForThread("after", cfg)).toBe("a");
  cfg.pausedCodexAccountIds = ["a"];
  expect(resolveCodexAccountForThread("paused", cfg)).toBe("b");
  cfg.pausedCodexAccountIds = []; cfg.activeCodexAccountId = "a";
  recordCodexUpstreamOutcome(cfg, "a", 429, { retryAfterMs: 60_000 });
  expect(resolveCodexAccountForThread("cooled", cfg)).toBe("b");
});

test("included quota at 100 is still held without paid-credit permission", () => {
  const cfg = config(); credentials();
  setCodexAccountUseRemainingQuota(cfg, "a", true);
  setAccountQuotaFromParsed("a", { weeklyPercent: 100, weeklyResetAt: Math.floor(Date.now() / 1000) + 3600 });
  updateAccountQuota("b", 5);
  expect(resolveCodexAccountForThread("no-paid", cfg)).toBe("b");
  expect(cfg.creditCodexAccountIds).toBeUndefined();
});

test("API persists only selected preference, preserves thresholds, and read status never saves", async () => {
  const cfg = config();
  const result = await request(cfg, { id: "a", useRemainingQuota: true });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ id: "a", useRemainingQuota: true, autoSwitchThreshold: 0 });
  expect(configModule.loadConfig().codexUseRemainingQuotaAccountIds).toEqual(["a"]);
  expect(getEffectiveCodexAutoSwitchThreshold(cfg, "b")).toBe(95);
  const saver = spyOn(configModule, "saveConfigPreservingClaudeCode").mockImplementation(() => { throw new Error("must not save"); });
  try { expect((await request(cfg, null, "GET")).status).toBe(200); } finally { saver.mockRestore(); }
  cfg.autoSwitchThreshold = 85;
  await request(cfg, { id: "a", useRemainingQuota: false });
  expect(getEffectiveCodexAutoSwitchThreshold(cfg, "a")).toBe(90);
  expect(cfg.codexAccountAutoSwitchThresholds).toEqual({ a: 90 });
});

test("main API opt-in returns the effective 100-percent protection and preserves paid-credit settings", async () => {
  const cfg = config(); observeMain(95);
  const response = await request(cfg, { id: "__main__", useRemainingQuota: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: "__main__", useRemainingQuota: true, autoSwitchThreshold: 0,
    mainAccountHardLock: { enabled: true, state: "ready", thresholds: { short: 100, long: 100 } } });
  expect(configModule.loadConfig().codexUseRemainingQuotaAccountIds).toEqual(["__main__"]);
  expect(cfg.creditCodexAccountIds).toBeUndefined();
});

test.each(["GET", "PUT"])("remaining-quota %s requires management credentials", method => {
  const cfg = config();
  const state: ManagementAuthState = { available: true, token: "fixture-admin-secret", source: "environment",
    sessions: new Map(), pairingGrants: new Map() };
  const url = "http://127.0.0.1/api/codex-auth/accounts/use-remaining?id=a";
  for (const token of [undefined, "fixture-provider-secret"]) {
    const headers = new Headers({ Host: "127.0.0.1" });
    if (token) headers.set("x-opencodex-api-key", token);
    expect(requireManagementAuth(new Request(url, { method, headers }), state, cfg)?.status).toBe(401);
  }
  expect(requireManagementAuth(new Request(url, { method, headers: {
    Host: "127.0.0.1", "x-opencodex-api-key": state.token,
  } }), state, cfg)).toBeNull();
});

test.each([null, [], { id: "a", useRemainingQuota: "true" }, { id: "__proto__", useRemainingQuota: true }])(
  "malformed use-remaining request is refused without mutation: %j", async body => {
    const cfg = config(); expect((await request(cfg, body)).status).toBe(400);
    expect(cfg.codexUseRemainingQuotaAccountIds).toBeUndefined();
  },
);
test("unknown account returns 404 and failed save rolls back live permission", async () => {
  const cfg = config();
  expect((await request(cfg, { id: "unknown", useRemainingQuota: true })).status).toBe(404);
  const saver = spyOn(configModule, "saveConfigPreservingClaudeCode").mockImplementation(() => { throw new Error("fixture-save-refused"); });
  try {
    await expect(request(cfg, { id: "a", useRemainingQuota: true })).rejects.toThrow("fixture-save-refused");
    expect(cfg.codexUseRemainingQuotaAccountIds).toBeUndefined();
    expect(getEffectiveCodexAutoSwitchThreshold(cfg, "a")).toBe(90);
  } finally { saver.mockRestore(); }
});
test("malformed persisted preference fails closed and account deletion removes its opt-in", () => {
  const cfg = config();
  expect(configSchema.parse({ ...cfg, codexUseRemainingQuotaAccountIds: ["__proto__"] }).codexUseRemainingQuotaAccountIds).toBeUndefined();
  expect(validateConfigCandidate({ ...cfg, codexUseRemainingQuotaAccountIds: ["__proto__"] })).toMatchObject({ ok: false });
  expect(validateConfigCandidate({ ...cfg, codexUseRemainingQuotaAccountIds: ["a", "__main__"] })).toMatchObject({ ok: true });
  setCodexAccountUseRemainingQuota(cfg, "a", true);
  setCodexAccountUseRemainingQuota(cfg, "b", true);
  credentials();
  deleteCodexAccount(cfg, "a");
  expect(cfg.codexUseRemainingQuotaAccountIds).toEqual(["b"]);
});
