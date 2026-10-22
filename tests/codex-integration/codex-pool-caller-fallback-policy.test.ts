import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexAuthContext, CodexPoolAuthenticationError, CodexAccountCooldownError } from "../../src/codex/auth-context";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearThreadAccountMap, clearCodexUpstreamHealth, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearMainAccountInfoCache, observeMainQuotaCredential, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { setMainAccountPlan } from "../../src/codex/main-account";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
let oldCodex: string | undefined;
let oldOcx: string | undefined;
let cfg: OcxConfig;
let info: ReturnType<typeof spyOn>;
const inbound = () => new Headers({ authorization: "Bearer fake-caller-bearer", "chatgpt-account-id": "fake-main-account" });
beforeEach(() => {
  info = spyOn(console, "info").mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), "ocx-caller-fallback-policy-"));
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
    codexAccounts: [{ id: "pool-a", email: "pool@example.test", chatgptAccountId: "fake-pool-account", isMain: false }] };
  saveCodexAccountCredential("pool-a", { accessToken: "fake-pool-bearer", refreshToken: "fake-refresh",
    expiresAt: Date.now() + 3600_000, chatgptAccountId: "fake-pool-account" });
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

test("manual pool preference still permits caller fallback when its account is excluded", async () => {
  const context = await resolveCodexAuthContext(inbound(), cfg, "pool", {
    requestScopedMainCredential: true, excludeAccountId: "pool-a",
  });
  expect(context).toMatchObject({ kind: "main", accountId: null });
  expect(cfg.activeCodexAccountPinned).toBe("pool-a");
  expect(info).toHaveBeenCalledWith("[codex] Pool selected caller-owned main credential.");
});

test("manual pool preference still permits caller fallback during quota cooldown", async () => {
  recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt: Date.now() + 600_000, fixedAccount: true });
  const context = await resolveCodexAuthContext(inbound(), cfg, "pool", { requestScopedMainCredential: true });
  expect(context).toMatchObject({ kind: "main", accountId: null });
  expect(cfg.activeCodexAccountId).toBe("pool-a");
  expect(info).toHaveBeenCalledWith("[codex] Pool selected caller-owned main credential.");
});

test("an exact pool binding refuses cooldown instead of using caller main", async () => {
  recordCodexUpstreamOutcome(cfg, "pool-a", 429, { resetAt: Date.now() + 600_000, fixedAccount: true });
  await expect(resolveCodexAuthContext(inbound(), cfg, "pool", {
    requestScopedMainCredential: true, accountId: "pool-a",
  })).rejects.toBeInstanceOf(CodexAccountCooldownError);
  expect(info).not.toHaveBeenCalled();
});

test("observed paused main cannot bypass a pool preference via exhaustion fallback", async () => {
  cfg.pausedCodexAccountIds = ["__main__"];
  observeMainQuotaIdentity("fake-main-account");
  observeMainQuotaCredential("fake-caller-bearer", "fake-main-account");
  await expect(resolveCodexAuthContext(inbound(), cfg, "pool", {
    requestScopedMainCredential: true, excludeAccountId: "pool-a",
  })).rejects.toBeInstanceOf(CodexPoolAuthenticationError);
  expect(info).not.toHaveBeenCalled();
});
