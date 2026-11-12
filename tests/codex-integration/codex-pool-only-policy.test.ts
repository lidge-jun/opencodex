import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexAuthContext, isCodexAuthContextUsable, CodexPoolAuthenticationError, CodexAccountCooldownError } from "../../src/codex/auth-context";
import { codexAccountUnusableReason, isCodexAccountUsable } from "../../src/codex/account-usability";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearThreadAccountMap, clearCodexUpstreamHealth, previewCodexAccountForRequest, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearMainAccountInfoCache } from "../../src/codex/main-account-cache";
import { setMainAccountPlan } from "../../src/codex/main-account";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #7410: `codexPool.poolOnly` keeps automatic Pool resolution off native main. Default mode keeps
 * the caller-main fallbacks recorded in codex-pool-caller-fallback-policy.test.ts; each pool-only
 * case below runs next to its default-mode control.
 */
let root: string;
let oldCodex: string | undefined;
let oldOcx: string | undefined;
let cfg: OcxConfig;
let info: ReturnType<typeof spyOn>;
const inbound = () => new Headers({ authorization: "Bearer fake-caller-bearer", "chatgpt-account-id": "fake-main-account" });
const poolOnly = (config: OcxConfig): OcxConfig => ({ ...config, codexPool: { ...config.codexPool, poolOnly: true } });
const storedMain = () => {
  // A usable native main login on disk, so dispatch revalidation can tell policy from credential.
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${part({ alg: "none" })}.${part({ exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "fake-main-account" } })}.fake-signature`;
  writeFileSync(join(root, "auth.json"), JSON.stringify({
    tokens: { access_token: jwt, refresh_token: "fake-main-refresh", account_id: "fake-main-account" },
  }));
  clearMainAccountInfoCache();
  const reads = { count: 0 };
  const options = {
    isMainAccountTokenLive: () => true,
    getValidMainAccountToken: async () => { reads.count += 1; return { accessToken: "fake-main-bearer", chatgptAccountId: "fake-main-account" }; },
  };
  return { reads, options };
};

function seedPool(id: string): void {
  saveCodexAccountCredential(id, { accessToken: `fake-${id}-bearer`, refreshToken: "fake-refresh",
    expiresAt: Date.now() + 3600_000, chatgptAccountId: `fake-${id}-account` });
}

beforeEach(() => {
  info = spyOn(console, "info").mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "ocx-pool-only-policy-"));
  oldCodex = process.env.CODEX_HOME;
  oldOcx = process.env.OPENCODEX_HOME;
  process.env.CODEX_HOME = root;
  process.env.OPENCODEX_HOME = root;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  cfg = { port: 10100, providers: {}, defaultProvider: "openai", codexMainAccountHardLock: false,
    autoSwitchThreshold: 0, activeCodexAccountId: "pool-a", activeCodexAccountPinned: "pool-a",
    codexAccounts: [{ id: "pool-a", email: "pool-a@example.test", chatgptAccountId: "fake-pool-a-account", isMain: false }] };
  seedPool("pool-a");
});
afterEach(() => {
  info.mockRestore();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  clearMainAccountInfoCache();
  setMainAccountPlan(null);
  if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  if (oldOcx === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldOcx;
  removeTreeWithRetry(root);
});

test("an excluded pool account refuses instead of using caller main", async () => {
  const control = await resolveCodexAuthContext(inbound(), cfg, "pool", { requestScopedMainCredential: true, excludeAccountId: "pool-a" });
  expect(control).toMatchObject({ kind: "main", accountId: null });
  info.mockClear();
  await expect(resolveCodexAuthContext(inbound(), poolOnly(cfg), "pool", {
    requestScopedMainCredential: true, excludeAccountId: "pool-a",
  })).rejects.toBeInstanceOf(CodexPoolAuthenticationError);
  expect(info).not.toHaveBeenCalled();
});

test("a cooled pool account refuses instead of using caller main", async () => {
  recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt: Date.now() + 600_000, fixedAccount: true });
  const control = await resolveCodexAuthContext(inbound(), cfg, "pool", { requestScopedMainCredential: true });
  expect(control).toMatchObject({ kind: "main", accountId: null });
  info.mockClear();
  await expect(resolveCodexAuthContext(inbound(), poolOnly(cfg), "pool", { requestScopedMainCredential: true }))
    .rejects.toBeInstanceOf(CodexAccountCooldownError);
  expect(info).not.toHaveBeenCalled();
});

test("an eligible alternate still serves under pool-only", async () => {
  cfg.codexAccounts!.push({ id: "pool-b", email: "pool-b@example.test", chatgptAccountId: "fake-pool-b-account", isMain: false });
  seedPool("pool-b");
  const context = await resolveCodexAuthContext(inbound(), poolOnly(cfg), "pool", {
    requestScopedMainCredential: true, excludeAccountId: "pool-a",
  });
  expect(context).toMatchObject({ kind: "pool", accountId: "pool-b" });
});

test("a manual main pin is not honoured as a main route under pool-only", async () => {
  cfg.activeCodexAccountId = "__main__";
  cfg.activeCodexAccountPinned = "__main__";
  const control = await resolveCodexAuthContext(inbound(), cfg, "pool", { requestScopedMainCredential: true });
  expect(control).toMatchObject({ kind: "main", accountId: null });
  const context = await resolveCodexAuthContext(inbound(), poolOnly(cfg), "pool", { requestScopedMainCredential: true });
  expect(context).toMatchObject({ kind: "pool", accountId: "pool-a" });
});

test("stored main is never selected or refreshed by automatic Pool resolution", async () => {
  cfg.activeCodexAccountId = "__main__";
  cfg.activeCodexAccountPinned = undefined;
  let mainReads = 0;
  const options = {
    isMainAccountTokenLive: () => true,
    getValidMainAccountToken: async () => { mainReads += 1; return { accessToken: "fake-main-bearer", chatgptAccountId: "fake-main-account" }; },
  };
  const served = await resolveCodexAuthContext(new Headers(), poolOnly(cfg), "pool", options);
  expect(served).toMatchObject({ kind: "pool", accountId: "pool-a" });
  await expect(resolveCodexAuthContext(new Headers(), poolOnly(cfg), "pool", { ...options, excludeAccountId: "pool-a" }))
    .rejects.toBeInstanceOf(CodexPoolAuthenticationError);
  expect(mainReads).toBe(0);
});

test("explicit main selectors and Direct mode stay outside the policy", async () => {
  const exact = await resolveCodexAuthContext(inbound(), poolOnly(cfg), "pool", {
    requestScopedMainCredential: true, accountId: "__main__",
  });
  expect(exact).toMatchObject({ kind: "main", accountId: null });
  const direct = await resolveCodexAuthContext(inbound(), poolOnly(cfg), "direct", {});
  expect(direct).toMatchObject({ kind: "main", accountId: null });
});

test("an exact stored __main__ selector serves and stays usable at dispatch", async () => {
  const { reads, options } = storedMain();
  const exact = await resolveCodexAuthContext(new Headers(), poolOnly(cfg), "pool", { ...options, accountId: "__main__" });
  expect(exact).toMatchObject({ kind: "main-pool", accountId: "__main__", fixedAccount: true });
  expect(reads.count).toBe(1);
  expect(isCodexAuthContextUsable(exact, poolOnly(cfg))).toBe(true);
});

test("an automatically selected main context is not reusable once the policy is on", async () => {
  cfg.activeCodexAccountId = "__main__";
  cfg.activeCodexAccountPinned = undefined;
  const { options } = storedMain();
  const automatic = await resolveCodexAuthContext(new Headers(), cfg, "pool", options);
  expect(automatic).toMatchObject({ kind: "main-pool", accountId: "__main__" });
  expect(isCodexAuthContextUsable(automatic, cfg)).toBe(true);
  expect(isCodexAuthContextUsable(automatic, poolOnly(cfg))).toBe(false);
});

test("the request preview does not name a pinned main under pool-only", () => {
  cfg.activeCodexAccountId = "__main__";
  cfg.activeCodexAccountPinned = "__main__";
  const live = { isMainAccountTokenLive: () => true };
  expect(previewCodexAccountForRequest(null, cfg, Date.now(), undefined, live)).toBe("__main__");
  expect(previewCodexAccountForRequest(null, poolOnly(cfg), Date.now(), undefined, live)).not.toBe("__main__");
});

test("selection and previews share one main decision", () => {
  const live = { requestOwnedMainCredential: true, isMainAccountTokenLive: () => true };
  expect(codexAccountUnusableReason(cfg, "__main__", live)).toBeUndefined();
  expect(codexAccountUnusableReason(poolOnly(cfg), "__main__", live)).toBe("pool_only");
  expect(isCodexAccountUsable(poolOnly(cfg), "__main__", live)).toBe(false);
  expect(codexAccountUnusableReason(poolOnly(cfg), "__main__", { ...live, explicitAccountSelector: true })).toBeUndefined();
  // Stored accounts are unaffected.
  expect(codexAccountUnusableReason(poolOnly(cfg), "pool-a")).toBeUndefined();
});

