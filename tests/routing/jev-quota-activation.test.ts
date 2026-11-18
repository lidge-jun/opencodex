import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { deactivateJevQuotaActivation, reconcileJevQuotaActivation, startJevQuotaActivation } from "../../src/combos/jev-quota-activation";
import { clearDecisionAccountQuotas, decisionQuotaSinkActive, publishDecisionAccountQuota, readLoadedDecisionQuotaPool } from "../../src/lib/decision-quota-sink";
import { decisionQuotaSnapshotWriteCountForTests, readLoadedDecisionQuotaPool as readSnapshotPool } from "../../src/providers/quota-decision-snapshot";
import { credentialGeneration, getAccountSet, loadAuthStore, saveAccountCredential, saveCredential } from "../../src/oauth/store";
import { capturePoolQuotaWriter, getCodexAccountCredential, loadCodexAccountStore, saveCodexAccountCredential } from "../../src/codex/account-store";
import { getMainQuotaCredentialGeneration, matchesMainQuotaCredential } from "../../src/codex/main-account-cache";
import { clearMainAccountCredentialPresence, clearMainAccountInfoCache, mainDecisionQuotaWriterGeneration, observeMainDecisionCredentialUsable, observeMainQuotaCredential, observeMainQuotaIdentity, setMainAccountCredentialPresence } from "../../src/codex/main-account-cache";
import { notifyLiveConfigObservers, reconcileLiveStateStores, setLiveStateStoreConfig } from "../../src/lib/state-store-registrations";
import { createOptionalListenerSet } from "../../src/server/index/optional-listeners";
import { handleComboRoutes } from "../../src/server/management/combo-routes";
import { ConfigWritePublishedError } from "../../src/config/persist-unlocked";
import * as oauthStoreModule from "../../src/oauth/store";
import { readAnthropicUsageQuota } from "../../src/providers/claude-cli-usage";
import { fetchProviderAccountQuotas, fetchProviderQuotaReports } from "../../src/providers/quota";
import { publishAnthropicDecisionQuota, publishCodexDecisionQuota } from "../../src/providers/quota-decision-publication";
import { probeAnthropicQuotaWithRecovery } from "../../src/providers/quota/anthropic-cooldown-recovery";
import { fetchAnthropicAccountQuota } from "../../src/providers/quota/anthropic-account-quota";
import { fetchAnthropicQuota, fetchAnthropicUsageProbeForInstance } from "../../src/providers/quota/vendor-probes-oauth";
import { accountCacheKey, clearAccountQuotaCache, getCachedProviderAccountQuota, hydrateAccountQuotaCache, recordAnthropicAccountQuotaFromHeaders, sweepExpiredProviderAccountQuotaRows } from "../../src/providers/quota/account-cache";
import { settleAccountQuotaPersistForTests } from "../../src/providers/account-quota-disk";
import { ACCOUNT_QUOTA_TTL_MS } from "../../src/providers/quota-wire";
import { captureConfigGeneration } from "../../src/lib/state-store-sweeper";
import { parseUpstreamQuotaHeaders, parseUsageQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { jevQuotaSignalForTarget, jevQuotaSignalFromWindows } from "../../src/combos/jev-quota";
import { bindRawCodexDecisionResets } from "../../src/providers/quota-decision-publication";
import { publishDecisionQuotaRoster } from "../../src/providers/quota-decision-snapshot";
import * as derivedRegistries from "../../src/config/derived-registries";
import { getConfigPath, saveConfig } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { anthropicHelperMessagesUrl, fetchAnthropicHelper, resolveAnthropicHelperSnapshot } from "../../src/sidecar/anthropic-binding";

const targets = [{ provider: "fixture", model: "m" }];
const enabled = { strategy: "jev" as const, targets, decisionQuotaSignals: true };
const pools = ["anthropic", "codex", "codex-main"] as const;
const authCredential = () => ({ access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 });
const codexCredential = () => ({ accessToken: "fixture-codex", refreshToken: "fixture-codex-refresh", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "fixture-subject" });
function config(combos: OcxConfig["combos"] = { saved: { ...enabled } }): OcxConfig {
  return { port: 0, defaultProvider: "fixture", providers: {
    fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["m"], liveModels: false },
  }, combos };
}
let homes: TempHome[];
let stopOwner: (() => void) | undefined;
let mainSequence = 0;
beforeEach(() => {
  homes = [createTempHome("ocx-jev-activation-")];
  deactivateJevQuotaActivation();
  clearMainAccountInfoCache();
  clearMainAccountCredentialPresence();
});
afterEach(() => {
  mock.restore();
  stopOwner?.(); stopOwner = undefined;
  deactivateJevQuotaActivation();
  clearMainAccountInfoCache();
  clearMainAccountCredentialPresence();
  setLiveStateStoreConfig(config({}));
  for (const home of homes.toReversed()) home.remove();
});
function switchHome(home: TempHome): void {
  process.env.OPENCODEX_HOME = home.configDir;
  process.env.CODEX_HOME = home.codexHome;
}
function newHome(): TempHome {
  const home = createTempHome("ocx-jev-activation-root-"); homes.push(home); return home;
}
function observeMain() {
  const id = `fixture-main-${++mainSequence}`;
  observeMainQuotaIdentity(id);
  setMainAccountCredentialPresence(true);
  observeMainDecisionCredentialUsable(true);
  const writer = observeMainQuotaCredential(`fixture-main-access-${mainSequence}`, id);
  expect(writer).toBeDefined();
  return writer!;
}
async function seedStores(suffix = "a") {
  const credential = { ...authCredential(), accountId: `fixture-auth-${suffix}` };
  await saveCredential("anthropic", credential);
  const authId = getAccountSet("anthropic")!.accounts[0]!.id;
  const codexId = `fixture-codex-${suffix}`;
  const generation = saveCodexAccountCredential(codexId, codexCredential());
  return { authId, credential, codexId, generation };
}
function expectWithdrawn(): void {
  expect(decisionQuotaSinkActive()).toBe(false);
  for (const provider of pools) {
    expect(readLoadedDecisionQuotaPool(provider)).toBeUndefined();
    // Check the backing snapshot too: detaching the slot must also withdraw retained rows.
    expect(readSnapshotPool(provider)).toBeUndefined();
  }
}
/** File and directory metadata plus bytes, excluding atime (reading is the permitted operation). */
function homeSnapshot(home: TempHome): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  function walk(path: string): void {
    const stat = statSync(path, { bigint: true });
    result[relative(home.root, path) || "."] = {
      mode: stat.mode.toString(), mtimeNs: stat.mtimeNs.toString(),
      ...(stat.isFile() ? { bytes: readFileSync(path).toString("base64") } : {}),
    };
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  }
  walk(home.root);
  return result;
}

describe("opt-in JEV quota activation", () => {
  for (const [label, combo] of [
    ["signals off", { ...enabled, decisionQuotaSignals: false }],
    ["signals unset", { strategy: "jev", targets }],
    ["non-JEV", { ...enabled, strategy: "failover" }],
  ] as const) test(`${label}: store load/persist and main transitions never reach the snapshot`, async () => {
    // The non-JEV case deliberately carries the flag to prove strategy is required as well.
    reconcileJevQuotaActivation(config({ saved: combo }));
    const before = decisionQuotaSnapshotWriteCountForTests();
    loadAuthStore(); loadCodexAccountStore();
    const seeded = await seedStores();
    loadAuthStore(); loadCodexAccountStore();
    await saveAccountCredential("anthropic", seeded.authId, { ...seeded.credential, access: "replacement" });
    saveCodexAccountCredential(seeded.codexId, { ...codexCredential(), accessToken: "replacement" });
    observeMain();
    observeMainDecisionCredentialUsable(false);
    setMainAccountCredentialPresence(false);
    clearMainAccountCredentialPresence(); clearMainAccountInfoCache();
    expect(decisionQuotaSnapshotWriteCountForTests()).toBe(before);
    expectWithdrawn();
  });

  test("activation after stores exist immediately replays both rosters without modifying home", async () => {
    const seeded = await seedStores();
    const before = homeSnapshot(homes[0]!);
    reconcileJevQuotaActivation(config());
    expect(decisionQuotaSinkActive()).toBe(true);
    expect(readLoadedDecisionQuotaPool("anthropic")).toEqual([{ id: seeded.authId, usable: true, windows: undefined }]);
    expect(readLoadedDecisionQuotaPool("codex")).toEqual([{ id: seeded.codexId, usable: true, windows: undefined }]);
    expect(homeSnapshot(homes[0]!)).toEqual(before);
  });

  test("invalid auth replay creates no invalid backup, chmod or mtime change and fails closed", () => {
    const home = homes[0]!;
    saveCodexAccountCredential("fixture-existing", codexCredential());
    writeFileSync(home.path("auth.json"), "{ invalid json", { mode: 0o644 });
    chmodSync(home.path("auth.json"), 0o644);
    chmodSync(home.root, 0o755);
    const before = homeSnapshot(home);
    expect(() => reconcileJevQuotaActivation(config())).not.toThrow();
    expect(decisionQuotaSinkActive()).toBe(true);
    const anthropic = readLoadedDecisionQuotaPool("anthropic");
    expect(anthropic === undefined || anthropic.length === 0).toBe(true);
    expect(readLoadedDecisionQuotaPool("codex")?.map(row => row.id)).toEqual(["fixture-existing"]);
    expect(readdirSync(home.root).filter(name => name.includes(".invalid-"))).toEqual([]);
    expect(homeSnapshot(home)).toEqual(before);
  });

  test("repeat reconcile is idempotent; two combos retain activation until last disable or deletion", async () => {
    await seedStores();
    const live = config({ first: { ...enabled }, second: { ...enabled } });
    reconcileJevQuotaActivation(live);
    const writes = decisionQuotaSnapshotWriteCountForTests();
    const roster = readLoadedDecisionQuotaPool("anthropic");
    reconcileJevQuotaActivation(live);
    expect(decisionQuotaSnapshotWriteCountForTests()).toBe(writes);
    live.combos!.first!.decisionQuotaSignals = false;
    reconcileJevQuotaActivation(live);
    expect(decisionQuotaSinkActive()).toBe(true);
    expect(readLoadedDecisionQuotaPool("anthropic")).toEqual(roster);
    expect(decisionQuotaSnapshotWriteCountForTests()).toBe(writes);
    live.combos!.second!.decisionQuotaSignals = false;
    reconcileJevQuotaActivation(live); expectWithdrawn();
    live.combos!.first!.decisionQuotaSignals = true;
    reconcileJevQuotaActivation(live);
    expect(decisionQuotaSinkActive()).toBe(true);
    delete live.combos!.first;
    reconcileJevQuotaActivation(live); expectWithdrawn();
  });

  test("a producer completion while inactive makes no snapshot write", () => {
    const before = decisionQuotaSnapshotWriteCountForTests();
    publishDecisionAccountQuota("codex", "fixture-late", 1, [{ window: "weekly", percent: 90, observedAt: Date.now() }]);
    expect(decisionQuotaSnapshotWriteCountForTests()).toBe(before);
    expectWithdrawn();
  });

  for (const parsedWhileActive of [false, true]) test(`Anthropic usage parsed while ${parsedWhileActive ? "active preserves raw invalid evidence" : "inactive stays unknown after activation"}`, async () => {
    const seeded = await seedStores();
    if (parsedWhileActive) reconcileJevQuotaActivation(config());
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({
      seven_day: { utilization: 120, resets_at: "explicitly-invalid" },
    })) as typeof globalThis.fetch);
    const quota = await readAnthropicUsageQuota(seeded.credential.access);
    expect(quota).not.toBeNull();
    expect(quota!.weeklyPercent).toBe(100); // Display projection loses both raw facts.
    expect(quota!.weeklyResetAt).toBeUndefined();
    reconcileJevQuotaActivation(config());
    const generation = credentialGeneration(seeded.credential);
    const check = () => {
      const row = readLoadedDecisionQuotaPool("anthropic")?.find(row => row.id === seeded.authId);
      expect(row).toMatchObject({ id: seeded.authId, usable: true });
      if (parsedWhileActive) {
        expect(row!.windows).toEqual([{ window: "weekly", percent: 120, observedAt: quota!.updatedAt, resetAt: NaN }]);
        expect(jevQuotaSignalFromWindows(row!.windows, "claude-sonnet-4", Date.now()).tier).toBe("unknown");
      } else expect(row!.windows).toBeUndefined();
    };
    publishAnthropicDecisionQuota(seeded.authId, generation, quota);
    check();
    clearDecisionAccountQuotas("anthropic", seeded.authId);
    // Feed the very same parsed object to the real recovery publisher; no fresh parse/binding.
    const recovery = await probeAnthropicQuotaWithRecovery(seeded.authId, seeded.credential.access, async () => quota, () => true);
    expect(recovery).not.toBeNull();
    recovery!.publishDecisionQuota();
    check();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("Anthropic monthly-only extra_usage publishes a monthly window, so an exhausted account is not unknown", async () => {
    const seeded = await seedStores();
    reconcileJevQuotaActivation(config());
    const usage = (utilization: number) => ({
      five_hour: null, seven_day: null, limits: [],
      extra_usage: { is_enabled: true, monthly_limit: 24300, used_credits: 24300, utilization },
    });
    spyOn(globalThis, "fetch").mockImplementation((async () => Response.json(usage(100))) as typeof globalThis.fetch);
    const quota = await readAnthropicUsageQuota(seeded.credential.access);
    expect(quota?.monthlyPercent).toBe(100);
    publishAnthropicDecisionQuota(seeded.authId, credentialGeneration(seeded.credential), quota);
    const row = readLoadedDecisionQuotaPool("anthropic")?.find(item => item.id === seeded.authId);
    expect(row!.windows).toEqual([{ window: "monthly", percent: 100, observedAt: quota!.updatedAt }]);
    expect(row!.windows).not.toEqual([]);
  });

  for (const source of ["response headers", "legacy usage probe", "sidecar response headers"] as const) {
    test(`Anthropic ${source} replace a spent monthly fallback with healthy plan evidence`, async () => {
      const { authId, credential } = await seedStores();
      const live = config();
      const model = "claude-sonnet-4";
      const baseUrl = "https://fixture.invalid";
      live.providers.anthropic = { adapter: "anthropic", authMode: "oauth", baseUrl, models: [model] };
      reconcileJevQuotaActivation(live);
      const fetch = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({
        limits: [], extra_usage: { is_enabled: true, utilization: 100 },
      })) as typeof globalThis.fetch);
      const signal = () => jevQuotaSignalFromWindows(
        readLoadedDecisionQuotaPool("anthropic")?.find(row => row.id === authId)?.windows, "claude-sonnet-4", Date.now(),
      );
      await fetchAnthropicAccountQuota("anthropic", authId, true, live);
      expect(getCachedProviderAccountQuota("anthropic", authId)?.monthlyPercent).toBe(100);
      expect(signal().tier).toBe("nearly_exhausted");

      if (source === "response headers") {
        recordAnthropicAccountQuotaFromHeaders(authId, new Headers({
          "anthropic-ratelimit-unified-7d-utilization": "0.16",
        }), captureConfigGeneration(), 200, "claude-sonnet-4", credentialGeneration(credential));
      } else if (source === "legacy usage probe") {
        fetch.mockImplementation((async () => Response.json({ seven_day: { utilization: 16 } })) as typeof globalThis.fetch);
        await fetchAnthropicAccountQuota("anthropic", authId, true, live);
      } else {
        const snapshot = await resolveAnthropicHelperSnapshot(live, "anthropic", model);
        fetch.mockResolvedValueOnce(new Response(null, { headers: { "anthropic-ratelimit-unified-7d-utilization": "0.16" } }));
        await fetchAnthropicHelper(live, snapshot, model, baseUrl, anthropicHelperMessagesUrl(baseUrl), {
          headers: { authorization: `Bearer ${snapshot.accessToken}` },
        });
      }

      const quota = getCachedProviderAccountQuota("anthropic", authId);
      expect(quota?.weeklyPercent).toBe(16);
      expect({ monthly: quota?.monthlyPercent, tier: signal().tier }).toEqual({ monthly: undefined, tier: "healthy" });
    });
  }

  test.each(["inactive", "malformed"] as const)("Anthropic %s plan evidence retires a previously observed monthly fallback", async kind => {
    const { authId } = await seedStores();
    const live = config();
    reconcileJevQuotaActivation(live);
    const monthly = { is_enabled: true, utilization: 100 };
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ extra_usage: monthly }));
    const windows = () => readLoadedDecisionQuotaPool("anthropic")?.find(row => row.id === authId)?.windows;
    await fetchAnthropicAccountQuota("anthropic", authId, true, live);
    expect(getCachedProviderAccountQuota("anthropic", authId)?.monthlyPercent).toBe(100);
    expect(windows()).toMatchObject([{ window: "monthly", percent: 100 }]);

    const plan = kind === "inactive"
      ? { five_hour: null, limits: [{ kind: "session", percent: 20, is_active: false }] }
      : { five_hour: { note: "no meter" } };
    fetch.mockResolvedValueOnce(Response.json({ ...plan, extra_usage: monthly }));
    const retired = await fetchAnthropicAccountQuota("anthropic", authId, true, live);
    expect(retired).toMatchObject({ unavailable: true, quotaFailure: "response_unusable", quota: null });
    expect({ quota: getCachedProviderAccountQuota("anthropic", authId), windows: windows() }).toEqual({ quota: null, windows: [] });
  });

  test("Anthropic explicit extra-usage disable retires monthly evidence while unknown responses retain it", async () => {
    const { authId } = await seedStores();
    const live = config();
    reconcileJevQuotaActivation(live);
    const read = () => fetchAnthropicAccountQuota("anthropic", authId, true, live);
    const windows = () => readLoadedDecisionQuotaPool("anthropic")?.find(row => row.id === authId)?.windows;
    const tier = () => jevQuotaSignalFromWindows(windows(), "claude-sonnet-4", Date.now()).tier;
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ extra_usage: { is_enabled: true, utilization: 100 } }));
    await read();
    expect(tier()).toBe("nearly_exhausted");

    for (const body of [{}, { extra_usage: { is_enabled: "false" } }, { extra_usage: { is_enabled: true } }]) {
      fetch.mockResolvedValueOnce(Response.json(body));
      expect(await read()).toMatchObject({ quotaFailure: "response_unusable", quota: { monthlyPercent: 100 } });
      expect(tier()).toBe("nearly_exhausted");
    }

    fetch.mockResolvedValueOnce(Response.json({ extra_usage: { is_enabled: false } }));
    const retired = await read();
    expect(retired).toMatchObject({ unavailable: true, quotaFailure: "response_unusable", quota: null });
    expect(getCachedProviderAccountQuota("anthropic", authId)).toBeNull();
    expect(windows()).toEqual([]);
    expect(tier()).toBe("unknown");
  });

  test.each([
    ["malformed five-hour usage", { five_hour: { note: "no meter" } }],
    ["disabled extra usage", { extra_usage: { is_enabled: false } }],
  ] as const)("Anthropic provider refreshes preserve the account failure for %s", async (_name, body) => {
    const { authId } = await seedStores();
    const live = config();
    live.providers.anthropic = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://fixture.invalid", models: ["claude-sonnet-4"] };
    reconcileJevQuotaActivation(live);
    clearAccountQuotaCache();
    const path = join(homes[0]!.configDir, "provider-account-quota-cache.json");
    const disk = () => JSON.parse(readFileSync(path, "utf8")).rows[accountCacheKey("anthropic", authId)];
    const windows = () => readLoadedDecisionQuotaPool("anthropic")?.find(row => row.id === authId)?.windows;
    const read = (force: boolean) => fetchProviderAccountQuotas("anthropic", force, live.providers.anthropic, live);
    const fetch = spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => Response.json({ extra_usage: { is_enabled: true, utilization: 100 } }))
      .mockImplementation(async () => Response.json(body));
    const flushDisk = async () => {
      jest.advanceTimersByTime(1_000);
      await settleAccountQuotaPersistForTests();
    };
    jest.useFakeTimers();
    try {
      await read(true);
      await flushDisk();
      expect(getCachedProviderAccountQuota("anthropic", authId)?.monthlyPercent).toBe(100);
      expect(windows()).toMatchObject([{ window: "monthly", percent: 100 }]);
      expect(disk()).toMatchObject({ monthlyPercent: 100 });

      const failure = { quota: null, unavailable: true, quotaFailure: "response_unusable" };
      const expectRetired = async () => {
        await flushDisk();
        expect(getCachedProviderAccountQuota("anthropic", authId)).toBeNull();
        expect(windows()).toEqual([]);
        expect(disk()).toBeUndefined();
      };
      expect(await read(true)).toMatchObject([failure]);
      await expectRetired();

      const cachedReads = [];
      for (let i = 0; i < 3; i++) {
        await fetchProviderQuotaReports(live, true);
        cachedReads.push(await read(false));
        await expectRetired();
      }
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(cachedReads).toMatchObject([[failure], [failure], [failure]]);
    } finally {
      clearAccountQuotaCache();
      jest.useRealTimers();
    }
  });

  for (const writer of ["account", "provider"] as const) {
    test(`Anthropic ${writer} plan probes replace the persisted monthly fallback across cold hydration`, async () => {
      const { authId } = await seedStores();
      const live = config();
      reconcileJevQuotaActivation(live);
      clearAccountQuotaCache();
      const path = join(homes[0]!.configDir, "provider-account-quota-cache.json");
      const other = { weeklyPercent: 42, updatedAt: Date.now() };
      const previous = { monthlyPercent: 100, updatedAt: Date.now() };
      writeFileSync(path, JSON.stringify({ version: 1, rows: {
        [accountCacheKey("anthropic", authId)]: previous,
        [accountCacheKey("anthropic2", "other-seat")]: other,
      } }));
      expect(getCachedProviderAccountQuota("anthropic", authId)).toBeNull(); // The first probe starts cold.
      const fetch = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ seven_day: { utilization: 16 } }));
      const read = writer === "account" ? () => fetchAnthropicAccountQuota("anthropic", authId, true, live)
        : () => fetchAnthropicQuota("anthropic", live);
      jest.useFakeTimers();
      try {
        await read();
        await read();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(getCachedProviderAccountQuota("anthropic", authId)).toMatchObject({ weeklyPercent: 16 });
        jest.advanceTimersByTime(1_000);
        await settleAccountQuotaPersistForTests();
        clearAccountQuotaCache();
        hydrateAccountQuotaCache();
        const hydrated = getCachedProviderAccountQuota("anthropic", authId);
        expect(hydrated).toMatchObject({ weeklyPercent: 16 });
        expect(hydrated?.monthlyPercent).toBeUndefined();
        expect(getCachedProviderAccountQuota("anthropic2", "other-seat")).toEqual(other);
      } finally {
        clearAccountQuotaCache();
        jest.useRealTimers();
      }
    });
  }

  test.each(["live", "expired"] as const)("Anthropic cold hydration drops mixed monthly evidence when the saved plan window is %s", async state => {
    const { authId } = await seedStores();
    clearAccountQuotaCache();
    try {
      const now = Date.now();
      const plan = { weeklyPercent: 16, weeklyResetAt: now + (state === "live" ? 60_000 : -1), updatedAt: now };
      writeFileSync(join(homes[0]!.configDir, "provider-account-quota-cache.json"), JSON.stringify({ version: 1, rows: {
        [accountCacheKey("anthropic", authId)]: { ...plan, monthlyPercent: 100 },
      } }));
      hydrateAccountQuotaCache();
      expect(getCachedProviderAccountQuota("anthropic", authId)).toEqual(state === "live" ? plan : null);
    } finally {
      clearAccountQuotaCache();
    }
  });

  test("Anthropic monthly-only probes replace older shared and family plan bars", async () => {
    const { authId } = await seedStores();
    const live = config();
    reconcileJevQuotaActivation(live);
    spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ seven_day: { utilization: 98 }, seven_day_opus: { utilization: 97 } }))
      .mockResolvedValueOnce(Response.json({ extra_usage: { is_enabled: true, utilization: 16 } }));
    const read = () => fetchAnthropicAccountQuota("anthropic", authId, true, live);
    await read();
    expect(getCachedProviderAccountQuota("anthropic", authId)).toMatchObject({ weeklyPercent: 98, customWindows: [{ percent: 97 }] });
    await read();
    expect(getCachedProviderAccountQuota("anthropic", authId)).toEqual({ monthlyPercent: 16, updatedAt: expect.any(Number) });
    expect(readLoadedDecisionQuotaPool("anthropic")?.find(row => row.id === authId)?.windows)
      .toEqual([{ window: "monthly", percent: 16, observedAt: expect.any(Number) }]);
  });

  for (const older of [
    { extra_usage: { is_enabled: true, utilization: 100 } },
    { five_hour: null, limits: [{ kind: "session", percent: 20, is_active: false }] },
  ]) {
    test(`Anthropic older ${"extra_usage" in older ? "monthly sample" : "retirement"} cannot override a newer monthly probe`, async () => {
      const { authId } = await seedStores();
      const live = config();
      reconcileJevQuotaActivation(live);
      const dispatched = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      spyOn(globalThis, "fetch").mockImplementationOnce(() => {
        dispatched.resolve();
        return response.promise;
      }).mockResolvedValueOnce(Response.json({ extra_usage: { is_enabled: true, utilization: 16 } }));
      const read = () => fetchAnthropicAccountQuota("anthropic", authId, true, live, true);
      const pending = read();
      await dispatched.promise;
      await read();
      response.resolve(Response.json(older));
      await pending;
      expect(getCachedProviderAccountQuota("anthropic", authId)?.monthlyPercent).toBe(16);
      expect(readLoadedDecisionQuotaPool("anthropic")?.find(row => row.id === authId)?.windows)
        .toEqual([{ window: "monthly", percent: 16, observedAt: expect.any(Number) }]);
    });
  }

  test("Anthropic inactive plan evidence leaves existing plan measurements and their clocks intact", async () => {
    const { authId, credential } = await seedStores();
    const live = config();
    reconcileJevQuotaActivation(live);
    const weekly = { seven_day: { utilization: 16 } };
    const inactive = { five_hour: null, limits: [{ kind: "session", percent: 20, is_active: false }] };
    spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json(weekly)).mockResolvedValueOnce(Response.json(inactive));
    await fetchAnthropicAccountQuota("anthropic", authId, true, live);
    const previous = getCachedProviderAccountQuota("anthropic", authId)!;
    const windows = () => readLoadedDecisionQuotaPool("anthropic")?.[0]?.windows;
    const monthly = { window: "monthly", percent: 100, observedAt: previous.updatedAt } as const;
    const plan = windows()!;
    publishDecisionAccountQuota("anthropic", authId, credentialGeneration(credential), [...plan, monthly]);
    expect(await fetchAnthropicQuota("anthropic", live)).toBeNull();
    expect(getCachedProviderAccountQuota("anthropic", authId)).toEqual(previous);
    expect(windows()).toEqual(plan);
  });

  test("Anthropic monthly-only probe cannot overwrite newer plan headers", async () => {
    const { authId, credential } = await seedStores();
    const live = config();
    reconcileJevQuotaActivation(live);
    const dispatched = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    spyOn(globalThis, "fetch").mockImplementationOnce(() => {
      dispatched.resolve();
      return response.promise;
    });
    const pending = fetchAnthropicAccountQuota("anthropic", authId, true, live);
    await dispatched.promise;
    recordAnthropicAccountQuotaFromHeaders(authId, new Headers({ "anthropic-ratelimit-unified-7d-utilization": "0.16" }),
      captureConfigGeneration(), 200, "claude-sonnet-4", credentialGeneration(credential));
    response.resolve(Response.json({ extra_usage: { is_enabled: true, utilization: 100 } }));
    await pending;
    expect({ quota: getCachedProviderAccountQuota("anthropic", authId), windows: readLoadedDecisionQuotaPool("anthropic")?.[0]?.windows })
      .toMatchObject({ quota: { weeklyPercent: 16 }, windows: [{ window: "weekly", percent: 16 }] });
    expect(getCachedProviderAccountQuota("anthropic", authId)?.monthlyPercent).toBeUndefined();
  });

  test("Anthropic shared usage flight keeps its original plan revision for readers joining after headers", async () => {
    const { authId, credential } = await seedStores();
    const response = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockImplementation(() => response.promise);
    const first = fetchAnthropicUsageProbeForInstance("anthropic", credential.access);
    recordAnthropicAccountQuotaFromHeaders(authId, new Headers({ "anthropic-ratelimit-unified-7d-utilization": "0.16" }),
      captureConfigGeneration(), 200, "claude-sonnet-4", credentialGeneration(credential));
    const joined = fetchAnthropicUsageProbeForInstance("anthropic", credential.access);
    sweepExpiredProviderAccountQuotaRows(Date.now() + ACCOUNT_QUOTA_TTL_MS);
    expect(getCachedProviderAccountQuota("anthropic", authId)).toBeNull();
    response.resolve(Response.json({ extra_usage: { is_enabled: true, utilization: 100 } }));
    expect(await joined).toBe(await first);
    expect((await joined).isQuotaDispatchCurrent(authId)).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  for (const source of ["wham", "response-header"] as const) for (const parsedWhileActive of [false, true]) {
    test(`Codex ${source} parsed while ${parsedWhileActive ? "active preserves invalid resets" : "inactive stays unknown after activation"}`, async () => {
      const seeded = await seedStores();
      const credential = getCodexAccountCredential(seeded.codexId)!;
      const writer = capturePoolQuotaWriter(seeded.codexId, { ...credential, generation: seeded.generation })!;
      expect(writer).toBeDefined();
      if (parsedWhileActive) reconcileJevQuotaActivation(config());
      const quota = source === "wham"
        ? parseUsageQuota({ rate_limit: { primary_window: { used_percent: 90, reset_at: -1 } } })
        : parseUpstreamQuotaHeaders(new Headers({ "x-codex-primary-used-percent": "90", "x-codex-primary-reset-at": "explicitly-invalid" }));
      expect(quota).not.toBeNull();
      expect(quota!.weeklyPercent).toBe(90);
      expect(quota!.weeklyResetAt).toBeUndefined();
      const observedAt = Date.now();
      reconcileJevQuotaActivation(config());
      const check = () => {
        const row = readLoadedDecisionQuotaPool("codex")?.find(row => row.id === seeded.codexId);
        expect(row).toMatchObject({ id: seeded.codexId, usable: true });
        if (parsedWhileActive) {
          expect(row!.windows).toHaveLength(1);
          expect(row!.windows![0]).toMatchObject({ window: "weekly", percent: 90, resetAt: NaN });
          expect(jevQuotaSignalFromWindows(row!.windows, "gpt-6-astra", Date.now()).tier).toBe("unknown");
        } else expect(row!.windows).toBeUndefined();
      };
      setAccountQuotaFromParsed(seeded.codexId, quota, undefined, undefined, null,
        { writer, source, raw: quota!, observedAt }, true);
      check();
      clearDecisionAccountQuotas("codex", seeded.codexId);
      publishCodexDecisionQuota(seeded.codexId, seeded.generation, quota!, observedAt);
      check();
    });
  }

  for (const deactivate of ["direct", "reconcile"] as const) test(`reentrant ${deactivate} deactivation inside an observe-only replay cannot restore any pool`, async () => {
    await seedStores();
    observeMain();
    const store = oauthStoreModule.peekAuthStore();
    const read = spyOn(oauthStoreModule, "peekAuthStore").mockImplementation(() => {
      expect(decisionQuotaSinkActive()).toBe(true);
      if (deactivate === "direct") deactivateJevQuotaActivation();
      else reconcileJevQuotaActivation(config({}));
      return store;
    });
    reconcileJevQuotaActivation(config());
    expect(read).toHaveBeenCalledTimes(1);
    expectWithdrawn();
  });

  test("reactivation rejects a removed generation and accepts a current generation's late completion", async () => {
    const seeded = await seedStores();
    reconcileJevQuotaActivation(config());
    const oldGeneration = credentialGeneration(seeded.credential);
    const oldCompletion = () => publishDecisionAccountQuota("anthropic", seeded.authId, oldGeneration,
      [{ window: "weekly", percent: 99, observedAt: Date.now() }]);
    deactivateJevQuotaActivation();
    const current = { ...seeded.credential, access: "fixture-current-access" };
    await saveAccountCredential("anthropic", seeded.authId, current);
    const currentGeneration = credentialGeneration(current);
    expect(currentGeneration).not.toBe(oldGeneration);
    const currentCompletion = () => publishDecisionAccountQuota("anthropic", seeded.authId, currentGeneration,
      [{ window: "weekly", percent: 35, observedAt: Date.now() }]);
    reconcileJevQuotaActivation(config());
    oldCompletion();
    expect(readLoadedDecisionQuotaPool("anthropic")?.[0]?.windows).toBeUndefined();
    currentCompletion();
    expect(readLoadedDecisionQuotaPool("anthropic")?.[0]?.windows).toMatchObject([{ window: "weekly", percent: 35 }]);
  });

  test("root adoption withdraws old rosters and main stays unknown until an owned observation", async () => {
    const homeA = homes[0]!;
    const a = await seedStores("a");
    const live = config();
    reconcileJevQuotaActivation(live);
    observeMain();
    expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.usable).toBe(true);
    const homeB = newHome();
    reconcileJevQuotaActivation(live);
    expect(readLoadedDecisionQuotaPool("anthropic")).toEqual([]);
    expect(readLoadedDecisionQuotaPool("codex")).toEqual([]);
    expect(readLoadedDecisionQuotaPool("codex-main")).toBeUndefined();
    switchHome(homeA); reconcileJevQuotaActivation(live);
    expect(readLoadedDecisionQuotaPool("codex-main")).toBeUndefined();
    switchHome(homeB); reconcileJevQuotaActivation(live);
    const b = await seedStores("b");
    expect(readLoadedDecisionQuotaPool("anthropic")?.map(row => row.id)).toEqual([b.authId]);
    expect(readLoadedDecisionQuotaPool("anthropic")?.some(row => row.id === a.authId)).toBe(false);
    expect(readLoadedDecisionQuotaPool("codex")?.map(row => row.id)).toEqual([b.codexId]);
    observeMain();
    expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.usable).toBe(true);
    switchHome(homeA); reconcileJevQuotaActivation(live);
    expect(readLoadedDecisionQuotaPool("anthropic")?.map(row => row.id)).toEqual([a.authId]);
    expect(readLoadedDecisionQuotaPool("codex")?.map(row => row.id)).toEqual([a.codexId]);
    expect(readLoadedDecisionQuotaPool("codex-main")).toBeUndefined();
  });

  test("presence/usability in another root cannot claim the previous root's main writer", () => {
    const live = config(); reconcileJevQuotaActivation(live);
    const writerA = observeMain();
    const generationA = mainDecisionQuotaWriterGeneration(writerA)!;
    expect(generationA).toBeNumber();
    newHome(); reconcileJevQuotaActivation(live);
    setMainAccountCredentialPresence(true); observeMainDecisionCredentialUsable(true);
    expect(mainDecisionQuotaWriterGeneration(writerA)).toBeUndefined();
    publishDecisionAccountQuota("codex-main", "__main__", generationA,
      [{ window: "weekly", percent: 99, observedAt: Date.now() }]);
    // Unknown for the new root: no row exists, so the late root-A write can neither attach windows nor mark it usable.
    expect(readLoadedDecisionQuotaPool("codex-main")).toBeUndefined();
    observeMain();
    expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.usable).toBe(true);
  });

  test("active store persists and main transitions update the registered snapshot", async () => {
    reconcileJevQuotaActivation(config());
    const seeded = await seedStores();
    expect(readLoadedDecisionQuotaPool("anthropic")?.[0]).toMatchObject({ id: seeded.authId, usable: true });
    expect(readLoadedDecisionQuotaPool("codex")?.[0]).toMatchObject({ id: seeded.codexId, usable: true });
    observeMain();
    expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.usable).toBe(true);
    observeMainDecisionCredentialUsable(false);
    expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.usable).toBe(false);
    observeMainDecisionCredentialUsable(true);
    expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.usable).toBe(true);
    setMainAccountCredentialPresence(false);
    expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.usable).toBe(false);
  });
});

describe("live owner lifecycle and published combo writes", () => {
  test("optional-listener construction registers nothing; start and stop own activation", async () => {
    const listeners = createOptionalListenerSet();
    try {
      notifyLiveConfigObservers(config()); expectWithdrawn();
      stopOwner = startJevQuotaActivation(config());
      expect(decisionQuotaSinkActive()).toBe(true);
      stopOwner(); expectWithdrawn();
      notifyLiveConfigObservers(config()); expectWithdrawn();
    } finally { await listeners.stop(); }
  });

  test("start twice keeps one live observer; a stale stop cannot detach its replacement", () => {
    const stopFirst = startJevQuotaActivation(config());
    stopOwner = startJevQuotaActivation(config());
    stopFirst(); expect(decisionQuotaSinkActive()).toBe(true);
    notifyLiveConfigObservers(config({})); expectWithdrawn();
    const before = decisionQuotaSnapshotWriteCountForTests();
    notifyLiveConfigObservers(config());
    const singleReplayWrites = decisionQuotaSnapshotWriteCountForTests() - before;
    expect(singleReplayWrites).toBeGreaterThan(0);
    const after = decisionQuotaSnapshotWriteCountForTests();
    notifyLiveConfigObservers(config());
    expect(decisionQuotaSnapshotWriteCountForTests()).toBe(after);
    stopOwner(); expectWithdrawn();
    notifyLiveConfigObservers(config()); expectWithdrawn();
  });

  test("notify, live config adoption and live reconciliation toggle the activation owner", () => {
    const live = config({});
    stopOwner = startJevQuotaActivation(live); expectWithdrawn();
    notifyLiveConfigObservers(config()); expect(decisionQuotaSinkActive()).toBe(true);
    notifyLiveConfigObservers(config({})); expectWithdrawn();
    setLiveStateStoreConfig(config()); expect(decisionQuotaSinkActive()).toBe(true);
    setLiveStateStoreConfig(live); expectWithdrawn();
    live.combos = { saved: { ...enabled } };
    reconcileLiveStateStores(); expect(decisionQuotaSinkActive()).toBe(true);
    delete live.combos.saved;
    reconcileLiveStateStores(); expectWithdrawn();
  });

  for (const method of ["PUT", "DELETE"] as const) test(`${method}: published save error still adopts the combo activation state`, async () => {
    const live = config(method === "PUT" ? {} : { saved: { ...enabled } });
    saveConfig(live);
    setLiveStateStoreConfig(live);
    stopOwner = startJevQuotaActivation(live);
    expect(decisionQuotaSinkActive()).toBe(method === "DELETE");
    const failure = new Error("fixture post-publication bookkeeping");
    const refresh = spyOn(derivedRegistries, "refreshConfigDerivedRegistries").mockImplementation(() => { throw failure; });
    const req = new Request(`http://127.0.0.1/api/combos${method === "DELETE" ? "?id=saved" : ""}`, {
      method, ...(method === "PUT" ? { headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "saved", combo: enabled }) } : {}),
    });
    await expect(handleComboRoutes({ req, url: new URL(req.url), config: live, deps: {}, version: "fixture",
      trustedLoopbackIngress: true, guiSessionIssuance: null,
      convergeCodexCatalog: async () => ({ status: "committed", changed: false, degraded: false, notices: [] }),
      syncClaudeAgentDefsBestEffort: async () => {},
    })).rejects.toBeInstanceOf(ConfigWritePublishedError);
    expect(refresh).toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    if (method === "PUT") {
      expect(persisted.combos.saved.decisionQuotaSignals).toBe(true);
      expect(live.combos?.saved?.decisionQuotaSignals).toBe(true);
      expect(decisionQuotaSinkActive()).toBe(true);
      expect(readLoadedDecisionQuotaPool("anthropic")).toEqual([]);
    } else {
      expect(persisted.combos?.saved).toBeUndefined();
      expect(live.combos?.saved).toBeUndefined();
      expectWithdrawn();
    }
  });
});

test("confirmed main absence is a known-unusable main, so an exhausted pool stays nearly exhausted", () => {
  const live = config();
  live.providers.openai = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "pool" } as OcxConfig["providers"][string];
  live.codexAccounts = [{ id: "a", isMain: false, email: "fixture@example.test" }, { id: "b", isMain: false, email: "fixture@example.test" }] as OcxConfig["codexAccounts"];
  reconcileJevQuotaActivation(live);
  setMainAccountCredentialPresence(false);
  expect(readLoadedDecisionQuotaPool("codex-main")).toEqual([{ id: "__main__", usable: false }]);
  publishDecisionQuotaRoster("codex", [{ id: "a", generation: 1, usable: true }, { id: "b", generation: 1, usable: true }]);
  const now = Date.now();
  for (const id of ["a", "b"]) {
    const raw = { weeklyPercent: 95 };
    bindRawCodexDecisionResets(raw, { short: undefined, weekly: undefined, monthly: undefined }, now);
    publishCodexDecisionQuota(id, 1, raw, now);
  }
  expect(jevQuotaSignalForTarget(live, "openai", "gpt-6-astra", now).tier).toBe("nearly_exhausted");
});

test("signals off: a failed main presence read keeps the core credential binding that policy checks match", () => {
  expect(decisionQuotaSinkActive()).toBe(false);
  observeMainQuotaIdentity("fixture-main-subject");
  observeMainQuotaCredential("fixture-main-bearer", "fixture-main-subject");
  const generation = getMainQuotaCredentialGeneration();
  setMainAccountCredentialPresence(false);
  clearMainAccountCredentialPresence();
  expect(getMainQuotaCredentialGeneration()).toBe(generation);
  expect(matchesMainQuotaCredential("fixture-main-bearer", "fixture-main-subject")).toBe(true);
});

test("active: lost main presence retires the main row's advisory windows and stale writers", () => {
  reconcileJevQuotaActivation(config());
  observeMainQuotaIdentity("fixture-main-subject");
  const writer = observeMainQuotaCredential("fixture-main-bearer", "fixture-main-subject")!;
  setMainAccountCredentialPresence(true);
  const generation = mainDecisionQuotaWriterGeneration(writer)!;
  publishDecisionAccountQuota("codex-main", "__main__", generation, [{ window: "weekly", percent: 50, observedAt: Date.now() }]);
  expect(readLoadedDecisionQuotaPool("codex-main")?.[0]?.windows?.[0]?.percent).toBe(50);
  setMainAccountCredentialPresence(false);
  expect(readLoadedDecisionQuotaPool("codex-main")).toEqual([{ id: "__main__", usable: false }]);
  expect(mainDecisionQuotaWriterGeneration(writer)).toBeUndefined();
  expect(matchesMainQuotaCredential("fixture-main-bearer", "fixture-main-subject")).toBe(true);
});
