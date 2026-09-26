import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { markAccountNeedsReauth, clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { getDefaultConfig } from "../../src/config/proxy-env";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, getAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { clearCodexUpstreamHealth, clearThreadAccountMap, previewCodexAccountForRequest,
  resolveCodexAccountForThread, resolveCodexAccountForThreadDetailed, resetCodexRoutingForManualSelection } from "../../src/codex/routing";
import { bindThreadAffinity, bindModelDetourAffinity } from "../../src/codex/routing/thread-affinity";
import type { OcxConfig } from "../../src/types";
import type { StoredAccountQuota } from "../../src/codex/quota-types";

const WINDOW = 5 * 60 * 60_000;
let now: number;
let home: TempHome;
let config: OcxConfig;
function idle(overrides: Partial<StoredAccountQuota> = {}) {
  setAccountQuotaFromParsed("idle-b", { weeklyPercent: 20, shortPercent: 0,
    shortWindowSeconds: 18000, shortResetAt: now + WINDOW });
  Object.assign(getAccountQuota("idle-b")!, { shortObservedAt: now }, overrides);
}
function resolve(thread: string | null = null, at = now) {
  return resolveCodexAccountForThread(thread, config, at);
}
beforeEach(() => {
  home = createTempHome("ocx-idle-window-");
  now = Date.now();
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState();
  config = { ...getDefaultConfig(), activeCodexAccountId: "idle-a", accountPoolStrategy: "quota",
    autoSwitchThreshold: 80, codexPool: { startIdleWindows: true },
    codexAccounts: ["idle-a", "idle-b"].map(id => ({ id, email: `${id}@example.test`, isMain: false })) };
  for (const id of ["idle-a", "idle-b"]) saveCodexAccountCredential(id, {
    chatgptAccountId: `test-account-${id}`, accessToken: `test-${id}`, refreshToken: `test-refresh-${id}`, expiresAt: now + 2 * WINDOW,
  });
  setAccountQuotaFromParsed("idle-a", { weeklyPercent: 10 });
  idle();
});
afterEach(async () => {
  clearAccountQuota(); clearCodexUpstreamHealth(); clearThreadAccountMap(); clearPoolRotationState();
  clearAccountNeedsReauth("idle-b");
  await flushConfigDirHardeningForTests();
  home.remove();
});

test.each([undefined, false])("disabled (%s) keeps ordinary selection", enabled => {
  config.codexPool = enabled === undefined ? undefined : { startIdleWindows: enabled };
  expect(resolve()).toBe("idle-a");
});
test("starts one real new conversation without changing the shared selection", () => {
  expect(resolve("new")).toBe("idle-b");
  expect(config.activeCodexAccountId).toBe("idle-a");
  expect(resolve("other")).toBe("idle-a");
  expect(resolve("new")).toBe("idle-b");
});
test("preview is read-only and agrees with resolve", () => {
  for (let i = 0; i < 2; i++) expect(previewCodexAccountForRequest("new", config, now)).toBe("idle-b");
  expect(resolve("new")).toBe("idle-b");
  expect(previewCodexAccountForRequest("other", config, now)).toBe("idle-a");
});
test("bound conversations stay on their account", () => {
  bindThreadAffinity("bound", "idle-a", now);
  expect(resolve("bound")).toBe("idle-a");
  expect(resolve("new")).toBe("idle-b");
});
test("manual pin and unspent manual preference outrank idle steering", () => {
  config.activeCodexAccountPinned = "idle-a";
  expect(resolve()).toBe("idle-a");
  delete config.activeCodexAccountPinned;
  resetCodexRoutingForManualSelection("idle-a");
  expect(resolve()).toBe("idle-a");
});
test("sliding idle resets do not rearm steering, but a new window does", () => {
  expect(resolve()).toBe("idle-b");
  idle({ shortObservedAt: now + 120000, shortResetAt: now + WINDOW + 120000 });
  expect(resolve(null, now + 120000)).toBe("idle-a");
  now += WINDOW + 120001;
  idle();
  expect(resolve()).toBe("idle-b");
});
test.each([
  { shortPercent: 1 }, { shortPercent: undefined }, { shortWindowSeconds: 3600 },
  { shortWindowSeconds: undefined }, { shortResetAt: undefined }, { shortResetAt: NaN },
  { shortObservedAt: undefined },
])("incomplete/non-idle evidence falls back: %j", patch => {
  idle(patch);
  expect(resolve()).toBe("idle-a");
});
test("elapsed, ticking, stale, and future observations fail closed", () => {
  for (const patch of [
    { shortResetAt: now - 1 }, { shortResetAt: now + WINDOW - 60001 },
    { shortResetAt: now + WINDOW + 60001 },
    { shortObservedAt: now - 300001, shortResetAt: now - 300001 + WINDOW },
    { shortObservedAt: now + 1, shortResetAt: now + 1 + WINDOW },
  ]) { idle(patch); expect(resolve()).toBe("idle-a"); }
});
test("seconds timestamps and the tolerance boundary are accepted", () => {
  idle({ shortResetAt: (now + WINDOW - 60000) / 1000 });
  expect(resolve()).toBe("idle-b");
});
test("paused and drained accounts are ineligible", () => {
  config.pausedCodexAccountIds = ["idle-b"];
  expect(resolve()).toBe("idle-a");
  config.pausedCodexAccountIds = [];
  idle({ weeklyPercent: 99 });
  expect(resolve()).toBe("idle-a");
});
test.each(["round-robin", "fill-first", "reset-first"] as const)("%s resumes after steering", strategy => {
  config.accountPoolStrategy = strategy;
  expect(resolve()).toBe("idle-b");
  idle({ shortPercent: 1, shortResetAt: undefined });
  expect(resolve()).toBe("idle-a");
});

test("family affinity takes precedence over idle placement", () => {
  bindThreadAffinity("parent", "idle-a", now);
  const lineage = { conversationKey: "child", rootSessionKey: "root",
    parentConversationKey: "parent", siblingConversationKeys: [] };
  expect(previewCodexAccountForRequest("child", config, now, undefined, undefined, undefined, lineage)).toBe("idle-a");
  expect(resolveCodexAccountForThread("child", config, now, undefined, lineage)).toBe("idle-a");
  expect(resolve("unrelated")).toBe("idle-b");
});
test("model detour affinity is never diverted", () => {
  bindModelDetourAffinity("bound", "idle-a", now, "test-model");
  const options = { modelEligibleAccountIds: new Set(["idle-a", "idle-b"]) };
  expect(previewCodexAccountForRequest("bound", config, now, undefined, options, "test-model")).toBe("idle-a");
  expect(resolveCodexAccountForThreadDetailed("bound", config, now, undefined, options, "test-model").accountId).toBe("idle-a");
  expect(resolve()).toBe("idle-b");
});
test("independent quota scopes do not use shared-window evidence", () => {
  expect(previewCodexAccountForRequest(null, config, now, "reserve")).toBe("idle-a");
  expect(resolveCodexAccountForThread(null, config, now, "reserve")).toBe("idle-a");
  expect(resolve()).toBe("idle-b");
});
test("model-ineligible and reauthentication accounts cannot be steered", () => {
  const options = { modelEligibleAccountIds: new Set(["idle-a"]) };
  expect(resolveCodexAccountForThreadDetailed(null, config, now, undefined, options).accountId).toBe("idle-a");
  markAccountNeedsReauth("idle-b");
  expect(resolve()).toBe("idle-a");
});
test("plan exclusions still apply", () => {
  config.codexAccounts![1]!.plan = "free";
  config.codexPool!.excludedPlans = ["free"];
  expect(resolve()).toBe("idle-a");
});
test("same-tick unbound requests reserve an idle account only once", () => {
  expect(Array.from({ length: 4 }, () => resolve())).toEqual(["idle-b", "idle-a", "idle-a", "idle-a"]);
});
