import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMainAccountHardLockStatus, resolveMainAccountHardLockThresholds } from "../../src/codex/main-account-hard-lock";
import { captureMainQuotaWriter, clearMainAccountInfoCache, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { clearAccountQuota, getMainPolicyQuota, setAccountQuotaFromParsed, type StoredAccountQuota } from "../../src/codex/quota";
import { configSchema } from "../../src/config/schema/config-schema";
import { removeTreeWithRetry } from "../helpers/remove-tree";
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-main-thresholds-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuota(); clearMainAccountInfoCache(); observeMainQuotaIdentity("threshold-fixture");
});
afterEach(() => {
  clearAccountQuota(); clearMainAccountInfoCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
function observe(quota: Omit<StoredAccountQuota, "updatedAt">) {
  setAccountQuotaFromParsed("__main__", quota, undefined, captureMainQuotaWriter("threshold-fixture"));
}
describe("per-window main-account hard lock", () => {
  test("5h at 90 blocks even with weekly headroom", () => {
    observe({ shortPercent: 90, weeklyPercent: 30 });
    expect(getMainAccountHardLockStatus({})).toEqual({ enabled: true, state: "blocked",
      thresholds: { short: 90, long: 98 }, window: "short" });
  });
  test("weekly 95 admits by default and blocks at a configured 95", () => {
    observe({ weeklyPercent: 95 });
    expect(getMainAccountHardLockStatus({}).state).toBe("ready");
    expect(getMainAccountHardLockStatus({ codexMainAccountHardLockThresholds: { long: 95 } }))
      .toMatchObject({ state: "blocked", window: "long", thresholds: { short: 90, long: 95 } });
  });
  test("configured thresholds govern independently, including monthly-only usage", () => {
    const config = { codexMainAccountHardLockThresholds: { short: 85, long: 96 } };
    observe({ shortPercent: 84.99, weeklyPercent: 95.99 });
    expect(getMainAccountHardLockStatus(config).state).toBe("ready");
    observe({ shortPercent: 85 });
    expect(getMainAccountHardLockStatus(config).window).toBe("short");
    clearAccountQuota();
    observe({ monthlyPercent: 96, monthlyIsPrimaryWindow: true });
    expect(getMainAccountHardLockStatus(config).window).toBe("long");
  });
  test("invalid in-memory values fall back and reversed values force short <= long", () => {
    expect(resolveMainAccountHardLockThresholds({ codexMainAccountHardLockThresholds: { short: 79, long: NaN } }))
      .toEqual({ short: 90, long: 98 });
    expect(resolveMainAccountHardLockThresholds({ codexMainAccountHardLockThresholds: { short: 99, long: 85 } }))
      .toEqual({ short: 85, long: 85 });
    expect(resolveMainAccountHardLockThresholds({ codexMainAccountHardLockThresholds: { short: 90.1, long: 101 } }))
      .toEqual({ short: 90, long: 98 });
  });
  test("malformed disk fields degrade individually without discarding valid siblings", () => {
    const parsed = configSchema.parse({ port: 10100, defaultProvider: "example", providers: { example: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
      codexMainAccountHardLockThresholds: { short: "85", long: 95 } });
    expect(resolveMainAccountHardLockThresholds(parsed)).toEqual({ short: 90, long: 95 });
  });
  test.each([{ weeklyPercent: 30 }, { resetCredits: 2 }, { shortResetAt: 4_000_000_000 }])(
    "92 percent short evidence survives elapsed reset and partial %j", partial => {
      const elapsed = Math.floor(Date.now() / 1000) - 60;
      observe({ shortPercent: 92, shortResetAt: elapsed, weeklyPercent: 30 });
      observe(partial);
      expect(getMainPolicyQuota()).toMatchObject({ shortPercent: 92, shortResetAt: elapsed });
      expect(getMainAccountHardLockStatus({}).state).toBe("blocked");
      observe({ shortPercent: 0 });
      expect(getMainAccountHardLockStatus({}).state).toBe("ready");
    });
  test("weekly evidence below 98 survives reset-only updates at the minimum threshold", () => {
    observe({ weeklyPercent: 80, weeklyResetAt: 4_000_000_000 });
    observe({ weeklyResetAt: 4_100_000_000 });
    expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 80, weeklyResetAt: 4_000_000_000 });
    expect(getMainAccountHardLockStatus({ codexMainAccountHardLockThresholds: { short: 80, long: 80 } }).state).toBe("blocked");
  });
});
