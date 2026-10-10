import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchMainAccountInfoAttempt } from "../../src/codex/auth-api/main-account-probe";
import { reconcileMainCodexAccountRuntimeState, resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";
import { saveCodexAccountCredential, capturePoolQuotaWriter } from "../../src/codex/account-store";
import { applyAccountQuotaFromUpstreamHeaders, clearAccountQuota, getAccountQuota, getMainPolicyQuota, parseUsageQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { commitPoolQuotaResponse } from "../../src/codex/auth-api/pool-quota-probe";
import { clearMainAccountInfoCache, observeMainQuotaIdentity, observeMainQuotaCredential, setMainAccountCredentialPresence } from "../../src/codex/main-account-cache";
import { readLoadedDecisionQuotaPool } from "../../src/providers/quota-decision-snapshot";
import { jevQuotaSignalFromWindows } from "../../src/combos/jev-quota";
import { captureConfigGeneration, reconcileStateGeneration } from "../../src/lib/state-store-sweeper";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const now = 2_000_000_000_000;
let home: TempHome;
let clock: ReturnType<typeof spyOn>;
beforeEach(() => {
  // An earlier file in the same bun process may have reconciled with an incomplete context: the owners that ran before the
  // failing one keep the raised fence while the shared generation stays behind, so every default-generation writer here
  // would be discarded as stale. A complete reconciliation realigns both without touching registrations.
  reconcileStateGeneration({ generation: 0, providerNames: new Set(), comboIds: new Set(), comboTargets: new Set(),
    codexAccountIds: new Set(), oauthAccountKeys: new Set(), configRoots: new Set() });
  home = createTempHome("ocx-jq-reset-");
  clock = spyOn(Date, "now").mockReturnValue(now);
  clearAccountQuota();
  clearMainAccountInfoCache();
});
afterEach(() => { clearAccountQuota(); resetMainCodexAccountIdentityTrackingForTests(); clock.mockRestore(); home.remove(); });
/** Capture a live main quota writer for the fixture identity and credential. */
function mainWriter() {
  observeMainQuotaIdentity("fixture-main");
  setMainAccountCredentialPresence(true);
  return observeMainQuotaCredential("fixture-access", "fixture-main")!;
}
/** Save a fixture pool credential and capture its quota writer. */
function poolWriter() {
  const credential = { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: now + 60_000, chatgptAccountId: "fixture-subject" };
  const generation = saveCodexAccountCredential("fixture", credential);
  return { generation, writer: capturePoolQuotaWriter("fixture", { ...credential, generation })! };
}
/** Loaded decision windows of the first account for a provider. */
const windows = (provider: string) => readLoadedDecisionQuotaPool(provider)![0]!.windows;

for (const reset of ["NaN", "Infinity", "-1", "invalid", ""]) {
  for (const owner of ["main", "pool"] as const) {
    test(`${owner} headers retain invalid reset ${JSON.stringify(reset)} without changing policy/display`, () => {
      const main = owner === "main" ? mainWriter() : undefined;
      const pool = owner === "pool" ? poolWriter() : undefined;
      const id = main ? "__main__" : "fixture";
      applyAccountQuotaFromUpstreamHeaders(id, new Headers({ "x-codex-primary-used-percent": "95", "x-codex-primary-reset-at": reset }), undefined, main,
        pool ? { poolWriter: pool.writer, poolResponse: true } : undefined);
      const advisory = windows(main ? "codex-main" : "codex");
      expect(advisory).toHaveLength(1);
      expect(Number.isNaN(advisory![0]!.resetAt)).toBe(true);
      expect(jevQuotaSignalFromWindows(advisory, "gpt-6-astra", now).tier).toBe("unknown");
      expect(getAccountQuota(id)).toMatchObject({ weeklyPercent: 95 });
      expect(getAccountQuota(id)!.weeklyResetAt).toBeUndefined();
      if (main) expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 95 });
    });
  }
  test(`pool WHAM retains invalid reset ${JSON.stringify(reset)} through its real commit boundary`, async () => {
    const pool = poolWriter();
    const result = await commitPoolQuotaResponse(Response.json({ rate_limit: { primary_window: { used_percent: 95, reset_at: reset, limit_window_seconds: 604800 } } }), {
      accountId: "fixture", existing: null, configuredPlan: "plus", generation: pool.generation, writerGeneration: captureConfigGeneration(), poolWriter: pool.writer,
    });
    expect(jevQuotaSignalFromWindows(windows("codex"), "gpt-6-astra", now).tier).toBe("unknown");
    expect(Number.isNaN(windows("codex")![0]!.resetAt)).toBe(true);
    expect(result.freshQuota).toEqual({ weeklyPercent: 95 });
  });
}

test("main WHAM producer retains raw invalid reset through its owned mocked refresh", async () => {
  resetLifecycleDrainStateForTests();
  resetMainCodexAccountIdentityTrackingForTests();
  const account = "fixture-main-wham";
  const claims = Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url");
  mkdirSync(home.codexHome, { recursive: true });
  writeFileSync(home.path(".codex", "auth.json"), JSON.stringify({ tokens: {
    access_token: `header.${claims}.signature`, refresh_token: "fixture-refresh", account_id: account,
  } }));
  reconcileMainCodexAccountRuntimeState();
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ plan_type: "plus", rate_limit: {
    primary_window: { used_percent: 95, reset_at: "Infinity", limit_window_seconds: 604800 },
  } })) as unknown as typeof globalThis.fetch);
  try {
    const result = await fetchMainAccountInfoAttempt(true, 0, undefined, false, true, false,
      { port: 0, defaultProvider: "p", providers: {} });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.freshQuota).toEqual({ weeklyPercent: 95 });
    expect(jevQuotaSignalFromWindows(windows("codex-main"), "gpt-6-astra", now).tier).toBe("unknown");
    expect(Number.isNaN(windows("codex-main")![0]!.resetAt)).toBe(true);
    expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 95 });
  } finally { fetch.mockRestore(); }
});

test("producer preserves short/secondary/tertiary reset validity independently", () => {
  const writer = mainWriter();
  applyAccountQuotaFromUpstreamHeaders("__main__", new Headers({
    "x-codex-primary-window-minutes": "300", "x-codex-primary-used-percent": "95", "x-codex-primary-reset-at": "NaN",
    "x-codex-secondary-used-percent": "70", "x-codex-secondary-reset-at": String((now + 60_000) / 1000),
    "x-codex-tertiary-used-percent": "99", "x-codex-tertiary-reset-at": "Infinity",
  }), undefined, writer);
  expect(jevQuotaSignalFromWindows(windows("codex-main"), "gpt-6-astra", now)).toMatchObject({ tier: "limited", usedPercent: 70, window: "weekly", resetsInSeconds: 60 });
});

test("omitted reset remains valid; partial headers never refresh an omitted window clock", () => {
  const writer = mainWriter();
  applyAccountQuotaFromUpstreamHeaders("__main__", new Headers({ "x-codex-primary-used-percent": "95" }), undefined, writer);
  expect(jevQuotaSignalFromWindows(windows("codex-main"), "gpt-6-astra", now).tier).toBe("nearly_exhausted");
  clock.mockReturnValue(now + 31 * 60_000);
  applyAccountQuotaFromUpstreamHeaders("__main__", new Headers({ "x-codex-primary-window-minutes": "300", "x-codex-primary-used-percent": "20" }), undefined, writer);
  expect(windows("codex-main")).toContainEqual({ window: "weekly", percent: 95, observedAt: now });
  expect(jevQuotaSignalFromWindows(windows("codex-main"), "gpt-6-astra", Date.now())).toMatchObject({ tier: "healthy", usedPercent: 20, window: "5h" });
});

test("parsed WHAM projection keeps its producer age instead of acquiring a commit clock", () => {
  const pool = poolWriter();
  const quota = parseUsageQuota({ rate_limit: { primary_window: { used_percent: 95, reset_at: (now + 3_600_000) / 1000 } } })!;
  clock.mockReturnValue(now + 31 * 60_000);
  setAccountQuotaFromParsed("fixture", quota, undefined, undefined, null, { writer: pool.writer, observedAt: Date.now(), source: "wham", raw: quota }, true);
  expect(windows("codex")![0]!.observedAt).toBe(now);
  expect(jevQuotaSignalFromWindows(windows("codex"), "gpt-6-astra", Date.now()).tier).toBe("unknown");
});

test("a live main writer without explicit decision evidence publishes no advisory window from display or policy data", () => {
  const writer = mainWriter();
  const quota = parseUsageQuota({ rate_limit: { primary_window: { used_percent: 95, reset_at: (now + 3_600_000) / 1000 } } })!;
  setAccountQuotaFromParsed("__main__", quota, undefined, writer, quota);
  expect(getAccountQuota("__main__")).toMatchObject({ weeklyPercent: 95 });
  expect(getMainPolicyQuota()).toMatchObject({ weeklyPercent: 95 });
  expect(readLoadedDecisionQuotaPool("codex-main")?.flatMap(row => row.windows ?? []) ?? []).toEqual([]);
});
