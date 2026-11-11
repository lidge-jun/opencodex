import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexAuthContext, CodexPoolAuthenticationError } from "../../src/codex/auth-context";
import { codexAccountUnusableReason, isCodexAccountUsable } from "../../src/codex/account-usability";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearThreadAccountMap, clearCodexUpstreamHealth, recordCodexUpstreamOutcome } from "../../src/codex/routing";
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
  const refused = await resolveCodexAuthContext(inbound(), poolOnly(cfg), "pool", { requestScopedMainCredential: true })
    .then(() => undefined, (error: unknown) => error);
  expect(refused).toBeInstanceOf(Error);
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

test("selection and previews share one main decision", () => {
  const live = { requestOwnedMainCredential: true, isMainAccountTokenLive: () => true };
  expect(codexAccountUnusableReason(cfg, "__main__", live)).toBeUndefined();
  expect(codexAccountUnusableReason(poolOnly(cfg), "__main__", live)).toBe("pool_only");
  expect(isCodexAccountUsable(poolOnly(cfg), "__main__", live)).toBe(false);
  expect(codexAccountUnusableReason(poolOnly(cfg), "__main__", { ...live, explicitAccountSelector: true })).toBeUndefined();
  // Stored accounts are unaffected.
  expect(codexAccountUnusableReason(poolOnly(cfg), "pool-a")).toBeUndefined();
});

